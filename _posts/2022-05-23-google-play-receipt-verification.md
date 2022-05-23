---
layout: post
title: Google Play 인앱 결제 서버 검증
date: 2022-05-23
tags: [django]
description: 결제 성공 여부는 클라이언트가 아니라 서버가 Google에 직접 확인해야 한다.
---

클라이언트가 "결제 성공"을 보내면 서버가 그대로 권한(entitlement)을 부여하는 구조는 요청 위조 한 번으로 우회된다. 서버는 클라이언트가 보낸 **구매 토큰(purchase token)**만 받아서 Google Play Developer API로 직접 상태를 조회해야 한다.

## 흐름

1. 앱: 결제가 완료되면 `purchaseToken`, `productId`를 서버로 보낸다.
2. 서버: Play Developer API로 구매 상태를 조회한다.
3. 서버: 상태와 중복 여부를 확인한 뒤 권한을 부여한다.
4. 서버: `acknowledge` 또는 `consume`을 호출한다.

## 조회 API

일회성 상품(one-time product)은 `purchases.products.get`을 사용한다.

```http
GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/purchases/products/{productId}/tokens/{token}
```

| 필드 | 의미 |
|---|---|
| `purchaseState` | 0: 구매 완료, 1: 취소, 2: 대기(pending) |
| `consumptionState` | 0: 미소비, 1: 소비 |
| `acknowledgementState` | 0: 미확인, 1: 확인 |
| `orderId` | 주문 번호 |

구독 상품은 2022년 5월 구독 개편과 함께 추가된 `purchases.subscriptionsv2.get`을 사용한다. 기존 `purchases.subscriptions.get`도 계속 동작하지만 이때 추가된 기본 요금제(base plan), 혜택(offer) 같은 새 기능은 v2에서만 지원한다.

## 인증

GCP에서 서비스 계정(service account)을 만들고 Play Console의 사용자 및 권한(Users and permissions)에서 서비스 계정 이메일을 사용자로 초대한다. 결제 관련 API를 쓰려면 **재무 데이터, 주문, 취소 설문조사 응답 보기**(View financial data, orders, and cancellation survey responses)와 **주문 및 구독 관리**(Manage orders and subscriptions) 두 권한을 모두 부여해야 한다.

```python
from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]
credentials = service_account.Credentials.from_service_account_file(
    settings.GOOGLE_SERVICE_ACCOUNT_FILE, scopes=SCOPES
)
publisher = build("androidpublisher", "v3", credentials=credentials, cache_discovery=False)
```

## 검증과 멱등성(idempotency)

```python
class Purchase(models.Model):
    user = models.ForeignKey(User, on_delete=models.PROTECT)
    product_id = models.CharField(max_length=100)
    purchase_token = models.CharField(max_length=512, unique=True)  # 공식 최대 길이가 없으므로 여유 있게
    order_id = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)


def verify_purchase(user, product_id, token):
    result = publisher.purchases().products().get(
        packageName=settings.PACKAGE_NAME, productId=product_id, token=token
    ).execute()

    if result.get("purchaseState") != 0:
        raise PurchaseNotCompleted()

    with transaction.atomic():
        purchase, created = Purchase.objects.get_or_create(
            purchase_token=token,
            defaults={"user": user, "product_id": product_id, "order_id": result["orderId"]},
        )
        if not created and purchase.user_id != user.id:
            raise PurchaseAlreadyUsed()
        if created:
            grant_membership(user, product_id)

    if result.get("acknowledgementState") == 0:
        publisher.purchases().products().acknowledge(
            packageName=settings.PACKAGE_NAME, productId=product_id, token=token, body={}
        ).execute()
```

- `purchase_token`에 유니크 제약(unique constraint)을 걸어 같은 영수증의 재사용을 막는다. Google은 토큰 길이 상한을 문서화하지 않으므로 길이를 넉넉히 잡거나, 토큰의 해시를 별도 유니크 컬럼으로 두는 방법도 있다.
- `get_or_create`는 동시 요청으로 `IntegrityError`가 나면 기존 행을 다시 조회하므로, 유니크 제약과 함께 쓰면 중복 생성 경합(race condition)을 처리할 수 있다. 공식 문서도 키워드 인자에 해당하는 필드의 유일성을 데이터베이스가 보장할 때만 이 메서드가 원자적으로 동작한다고 명시한다.
- 네트워크 재시도로 같은 요청이 두 번 와도 결과가 같아야 한다.

## acknowledge

Play Billing Library 2.0부터 구매 후 **3일 안에 acknowledge**하지 않으면 자동 환불되고 구매가 취소된다. 대기(pending) 구매는 구매 완료 상태로 바뀐 뒤부터 이 기한이 적용된다. 소모성 상품(consumable)은 `consume`(클라이언트 `consumeAsync` 또는 서버 `purchases.products.consume`)이 acknowledge를 겸한다. 권한 부여가 끝난 뒤 서버에서 처리하면 권한 부여 실패 시 환불되도록 할 수 있다.

## 사후 변경 처리

환불, 취소는 결제 이후에 발생한다.

- **Real-time Developer Notifications**: Pub/Sub으로 구독 상태 변경과 일회성 상품의 구매·취소 이벤트(`ONE_TIME_PRODUCT_PURCHASED`, `ONE_TIME_PRODUCT_CANCELED`)를 받는다. 알림에는 상태가 바뀌었다는 사실과 토큰만 담기므로 받은 뒤 Play Developer API로 다시 조회한다.
- **Voided Purchases API**: 환불·취소된 구매 목록을 주기적으로 조회해 권한을 회수한다.
