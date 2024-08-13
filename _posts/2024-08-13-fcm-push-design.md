---
layout: post
title: FCM 푸시 설계 — 토큰 관리, notification과 data 메시지, iOS APNs
date: 2024-08-13
tags: [flutter]
description: FCM 등록 토큰의 수명 주기와 정리 방법, HTTP v1 API 전송, 앱 상태별 메시지 처리, Android 채널과 iOS APNs 설정을 정리한다.
---

푸시 알림은 "서버에서 보내면 휴대폰에 뜬다"로 요약되지만, 실제로는 세 주체가 얽힌 시스템이다. 앱은 FCM에서 등록 토큰(Registration Token)을 받아 서버에 알리고, 서버는 그 토큰으로 FCM에 전송을 요청하고, FCM은 Android 기기에는 직접, iOS 기기에는 APNs(Apple Push Notification service)를 거쳐 전달한다. 이 글은 이 경로에서 설계해야 하는 네 가지, 토큰 관리, 메시지 종류, 플랫폼별 설정, 전송 방식을 다룬다.

## 등록 토큰의 수명 주기

등록 토큰은 "이 기기의 이 앱 설치본"을 가리키는 주소다. 사용자 계정이 아니라 앱 인스턴스에 붙는다. 한 사용자가 기기 세 대를 쓰면 토큰도 세 개이고, 한 기기를 두 사용자가 번갈아 로그인해 쓰면 같은 토큰이 다른 사용자에게 넘어간다.

토큰은 고정값이 아니다. 앱을 새 기기에 복원하거나, 재설치하거나, 앱 데이터를 지우면 새 토큰이 발급된다. 그래서 클라이언트는 시작할 때 현재 토큰을 서버에 올리고, `onTokenRefresh`를 구독해 바뀔 때마다 다시 올린다. FlutterFire 문서에 따르면 이 스트림은 토큰이 새로 생성될 때뿐 아니라 앱이 시작될 때마다 호출된다.

```dart
Future<void> registerPushToken(ApiClient api) async {
  final messaging = FirebaseMessaging.instance;
  final settings = await messaging.requestPermission(
    alert: true,
    badge: true,
    sound: true,
  );
  if (settings.authorizationStatus == AuthorizationStatus.denied) return;

  if (Platform.isIOS) {
    final apnsToken = await messaging.getAPNSToken();
    if (apnsToken == null) return;
  }

  final token = await messaging.getToken();
  if (token != null) await api.upsertPushToken(token);

  messaging.onTokenRefresh.listen(api.upsertPushToken);
}
```

iOS에서는 APNs 토큰이 먼저 준비되어 있어야 한다. Firebase iOS SDK 10.4.0 이상에서는 APNs 토큰이 없을 때 FCM API를 호출하면 오류가 나므로, `getAPNSToken()`이 값을 돌려준 뒤에 `getToken()`을 부른다.

### 서버의 토큰 저장소

Firebase의 토큰 관리 모범 사례 문서가 권하는 핵심은 **토큰마다 타임스탬프를 저장하고 오래된 토큰을 주기적으로 지우는 것**이다.

```sql
CREATE TABLE push_token (
  token        VARCHAR(512) PRIMARY KEY,
  user_id      BIGINT       NOT NULL,
  platform     VARCHAR(16)  NOT NULL,
  updated_at   TIMESTAMP    NOT NULL
);
CREATE INDEX idx_push_token_user ON push_token (user_id);
```

- **토큰을 기본 키로** 둔다. 같은 기기에서 다른 사용자가 로그인하면 `user_id`만 갱신된다. 로그아웃할 때는 해당 토큰 행을 지워서 이전 사용자의 알림이 가지 않게 한다.
- **`updated_at`을 갱신**한다. 앱이 시작할 때마다 토큰을 올리면 갱신 시각이 곧 "최근에 살아 있었다"는 신호가 된다.
- **오래된 토큰을 정리**한다. FCM은 한 달 동안 연결되지 않은 앱 인스턴스의 등록을 오래된(stale) 것으로 본다. 문서는 하루 한 번 정도 배치로 이 기준을 넘긴 토큰을 지우는 방식을 예로 든다. Android에서는 270일 동안 비활성인 토큰이 만료되어 FCM이 전송을 거부하지만, iOS에는 이런 만료가 없으므로 서버가 직접 지워야 한다.

### 전송 오류로 정리하기

전송 응답도 정리 신호다. HTTP v1 API가 `UNREGISTERED`(HTTP 404)를 돌려주면 앱이 삭제되었거나 토큰이 만료된 것이므로 바로 지운다. `INVALID_ARGUMENT`(HTTP 400)는 토큰이 잘못된 경우에도 나오지만 페이로드가 잘못된 경우에도 나오므로, 페이로드가 정상이라는 확신이 있을 때만 토큰 삭제 근거로 쓴다. Admin SDK에서는 각각 `messaging/registration-token-not-registered`, `messaging/invalid-registration-token`(토큰 형식 오류) 같은 오류 코드로 구분된다.

## HTTP v1 API로 전송하기

FCM의 레거시 HTTP·XMPP 프로토콜과 서버 키(Server Key) 인증은 2023년에 지원 중단이 공지되었고, 2024년 6월 20일부터 종료되기 시작했다. 현재 서버 전송 경로는 HTTP v1 API 하나다.

```http
POST https://fcm.googleapis.com/v1/projects/my-project/messages:send
Authorization: Bearer ya29.a0Af...
Content-Type: application/json
```

v1 API는 서비스 계정으로 발급한 OAuth 2.0 액세스 토큰(`https://www.googleapis.com/auth/firebase.messaging` 범위)으로 인증한다. 정적인 서버 키를 헤더에 넣던 방식과 달리 토큰은 짧게 만료되므로, 직접 HTTP를 호출하기보다 토큰 발급을 대신해 주는 Admin SDK를 쓰는 편이 간단하다.

Node.js Admin SDK에서는 레거시 일괄 전송 API에 기대던 `sendMulticast()`, `sendAll()`이 11.7.0에서 사용 중단되고, 메시지마다 v1 API를 호출하는 `sendEachForMulticast()`, `sendEach()`가 추가되었다. 한 번에 최대 500개 토큰까지 보낼 수 있다.

```typescript
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';

initializeApp({ credential: applicationDefault() });

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export async function notifyUser(
  userId: number,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<void> {
  const tokens = await tokenRepository.findByUserId(userId);

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const message: MulticastMessage = {
      tokens: chunk,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: { channelId: 'activity' },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      },
    };

    const result = await getMessaging().sendEachForMulticast(message);
    const dead = result.responses
      .map((r, idx) => (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code) ? chunk[idx] : null))
      .filter((t): t is string => t !== null);

    if (dead.length > 0) await tokenRepository.deleteMany(dead);
  }
}
```

`data`의 값은 모두 문자열이어야 한다. 숫자나 객체는 문자열로 직렬화해 넣고 앱에서 다시 파싱한다.

## notification 메시지와 data 메시지

FCM 메시지는 `notification` 필드가 있느냐에 따라 동작이 갈린다.

- **notification 메시지**: 제목과 본문처럼 미리 정해진 키를 담는다. 앱이 백그라운드에 있으면 FCM SDK(iOS는 시스템)가 알림 트레이에 직접 띄운다.
- **data 메시지**: 개발자가 정한 키-값만 담는다. 표시 여부와 방법을 앱 코드가 결정한다. `from`, `google.`이나 `gcm.`으로 시작하는 키처럼 예약된 이름은 쓸 수 없다.
- **둘 다 포함**: 백그라운드에서는 알림이 트레이에 뜨고 data는 사용자가 알림을 눌렀을 때 앱에 전달된다. 포그라운드에서는 두 페이로드를 모두 담은 메시지 하나가 앱에 전달된다.

Flutter에서 앱 상태별로 어떤 코드가 실행되는지 정리하면 다음과 같다.

| 앱 상태 | notification 메시지 | data 메시지 |
|---|---|---|
| 포그라운드 | `onMessage` 호출, 기본적으로 알림이 표시되지 않음 | `onMessage` 호출 |
| 백그라운드 | 시스템이 알림 표시, 누르면 `onMessageOpenedApp` | `onBackgroundMessage` 핸들러 실행 |
| 종료(Terminated) | 시스템이 알림 표시, 누르면 `getInitialMessage()` | `onBackgroundMessage` 핸들러 실행(전달 보장 없음) |

몇 가지 전제가 있다. 앱이 한 번은 실행되어 토큰을 등록했어야 하고, iOS에서 사용자가 앱 전환기에서 앱을 쓸어 종료했거나 Android에서 설정 화면으로 강제 종료했다면 사용자가 다시 열기 전까지 백그라운드 메시지가 처리되지 않는다.

`onBackgroundMessage` 핸들러는 익명 함수가 아닌 최상위(top-level) 함수여야 하고, Flutter 3.3.0 이상에서는 릴리스 빌드의 트리 셰이킹(Tree Shaking)으로 제거되지 않도록 `@pragma('vm:entry-point')`를 붙여야 한다. Android에서는 별도 아이솔레이트(Isolate)에서 실행되므로 UI 상태에 접근할 수 없고, 30초를 넘기는 작업은 OS가 프로세스를 종료할 수 있다.

```dart
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();
  await LocalBadgeStore.increment();
}

// main()에서 runApp 전에 등록
FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
```

사용자에게 보여야 하는 알림은 notification 메시지로 보내는 것이 안전하다. data 메시지만으로 알림을 그리려면 앱 코드가 반드시 실행되어야 하는데, 백그라운드 실행은 두 OS 모두 제한한다. data 메시지는 화면 갱신 신호, 배지 숫자, 알림에 덧붙일 라우팅 정보 용도로 쓴다.

## 우선순위와 전달 제약

Android에서는 메시지 우선순위가 `normal`과 `high`로 나뉜다. normal 메시지는 기기가 잠자기(Doze) 상태이면 깨어날 때까지 지연될 수 있고, high 메시지는 즉시 전달을 시도하며 기기를 깨운다. 다만 high로 보낸 메시지가 사용자에게 보이는 알림으로 이어지지 않으면 FCM이 해당 앱 인스턴스의 이후 메시지를 normal로 낮출 수 있다. high는 채팅이나 사용자 행동이 필요한 알림처럼 즉시 보여야 하는 것에만 쓴다.

iOS에서는 APNs 요청 헤더 `apns-priority`가 같은 역할을 한다. `10`은 즉시 전달, `5`는 기기 전원 상황을 고려해 전달한다. 알림 없이 앱을 깨우는 백그라운드 알림(Background Notification)은 `aps`에 `content-available: 1`만 넣고, `apns-push-type: background`와 `apns-priority: 5`를 함께 써야 한다. 이 조합에 우선순위 10을 쓰는 것은 오류다.

```typescript
await getMessaging().send({
  token,
  data: { type: 'feed_updated' },
  apns: {
    headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
    payload: { aps: { contentAvailable: true } },
  },
  android: { priority: 'normal' },
});
```

Apple 문서는 백그라운드 알림을 낮은 우선순위로 취급하며 전달을 보장하지 않고, 너무 많으면 시스템이 제한한다고 설명한다. 시간당 두세 개를 넘기지 말라는 권고도 있다. 백그라운드 알림은 "새 데이터가 있을 수 있다"는 힌트로만 쓰고, 실제 동기화는 앱이 열릴 때 다시 확인하도록 설계한다.

**페이로드 크기**: FCM 메시지는 키와 값을 합쳐 최대 4096바이트, 토픽으로 보내는 메시지는 2048바이트까지다. APNs도 일반 알림 페이로드를 4KB로 제한한다. 본문 전체를 실어 보내지 말고 ID만 보낸 뒤 앱이 API로 가져온다.

## Android: 알림 채널과 권한

Android 8.0(API 26)부터 모든 알림은 채널(Notification Channel)에 속해야 한다. 채널의 중요도(Importance)가 소리와 헤즈업(Heads-up) 표시 여부를 결정하며, **채널을 만든 뒤에는 앱이 중요도를 바꿀 수 없고 사용자만 바꿀 수 있다.** 중요도를 잘못 정해 출시하면 채널 ID를 새로 만드는 수밖에 없다.

FCM은 기본 채널을 제공하지만 중요도를 통제하려면 직접 만든 채널을 기본값으로 지정한다.

```xml
<meta-data
    android:name="com.google.firebase.messaging.default_notification_channel_id"
    android:value="activity" />
```

채널 자체는 앱 코드에서 만들어야 한다. Flutter에서는 `flutter_local_notifications`로 앱 시작 시 생성한다. 포그라운드에서 notification 메시지를 헤즈업으로 띄우려면 높은 중요도의 채널이 필요하다.

```dart
const channel = AndroidNotificationChannel(
  'activity',
  '활동 알림',
  description: '댓글, 팔로우 등 내 활동에 대한 알림',
  importance: Importance.high,
);

await FlutterLocalNotificationsPlugin()
    .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
    ?.createNotificationChannel(channel);
```

Android 13(API 33)부터는 알림 표시에 런타임 권한이 필요하다. `requestPermission()`은 iOS와 Android 13 이상에서 권한 대화상자를 띄운다. 거부되면 다시 묻기 어려우므로, 첫 실행 직후보다 알림의 가치를 설명할 수 있는 시점에 요청하는 편이 낫다.

## iOS: APNs 인증 키와 기능 설정

FCM이 iOS 기기에 보내려면 Firebase 프로젝트에 APNs 인증 정보를 등록해야 한다. 방식은 두 가지다.

| 항목 | APNs 인증 키(.p8) | APNs 인증서(.p12) |
|---|---|---|
| 범위 | 팀의 모든 앱, 개발·운영 환경 공용 | 앱 하나, 환경별로 따로 |
| 만료 | 없음(폐기 전까지 유효) | 1년마다 갱신 필요 |
| Firebase 등록 정보 | 키 파일, 키 ID, 팀 ID | 인증서 파일과 비밀번호 |

갱신 부담이 없는 인증 키가 일반적인 선택이다. Firebase 콘솔의 프로젝트 설정 → 클라우드 메시징에서 키 파일과 키 ID, 팀 ID를 등록한다. Xcode에서는 Runner 타깃에 Push Notifications 기능과 Background Modes의 Remote notifications를 켠다.

iOS는 포그라운드에서 알림을 기본적으로 표시하지 않는다. 표시하려면 `setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true)`로 표시 옵션을 바꾼다.

## 토큰 전송과 토픽 전송

| 항목 | 토큰 전송 | 토픽 전송 |
|---|---|---|
| 대상 지정 | 서버가 토큰 목록을 가짐 | 기기가 토픽을 구독, 서버는 토픽 이름만 앎 |
| 적합한 용도 | 개인화된 알림, 특정 사용자 대상 | 공지, 카테고리 구독처럼 다수에게 같은 내용 |
| 페이로드 한도 | 4096바이트 | 2048바이트 |
| 지연 특성 | 일반적인 전송 지연 | 처리량(Throughput) 위주로 최적화, 지연은 상대적으로 큼 |
| 수신자 파악 | 서버가 정확히 앎 | 서버가 구독자를 알 수 없음 |
| 정리 | 서버가 오래된 토큰 삭제 | 비활성 토큰을 구독 해제해야 함 |

토픽은 서버에서 Admin SDK의 `subscribeToTopic()`으로 구독시킬 수도 있으며, 한 요청에 최대 1,000개 토큰까지 처리한다. 사용자별 설정(야간 알림 끄기, 특정 유형 거부)을 반영해야 한다면 토픽보다 서버에서 대상을 걸러 토큰으로 보내는 방식이 관리하기 쉽다.

## 알림을 눌렀을 때

알림 클릭으로 특정 화면을 여는 처리, 즉 종료 상태에서의 `getInitialMessage()`와 백그라운드 상태에서의 `onMessageOpenedApp`을 라우터와 연결하는 부분은 딥 링크 처리와 같은 문제이므로 딥 링크 글에서 함께 다룬다. 서버 쪽에서는 `data`에 `route` 같은 키로 이동할 경로를 함께 실어 보내 두면 된다.

## 정리

1. 등록 토큰은 사용자가 아니라 앱 설치본에 붙는다. 토큰을 기본 키로 저장하고 로그인·로그아웃 때 사용자 연결을 갱신한다.
2. 앱 시작과 `onTokenRefresh`마다 토큰과 갱신 시각을 서버에 올리고, 한 달 이상 갱신되지 않은 토큰은 배치로 지운다. iOS 토큰은 자동 만료가 없다.
3. `UNREGISTERED`는 즉시 삭제하고, `INVALID_ARGUMENT`는 페이로드 문제와 구분한 뒤 판단한다.
4. 레거시 API는 2024년 6월부터 종료되었으므로 HTTP v1 API와 `sendEach` 계열 Admin SDK 메서드를 쓴다.
5. 사용자에게 보여야 하는 알림은 notification 메시지로, 앱 내부 신호는 data 메시지로 보낸다. 포그라운드 표시는 Android 채널과 iOS 표시 옵션으로 따로 설정한다.
6. high 우선순위와 `apns-priority: 10`은 보이는 알림에만 쓰고, 백그라운드 알림은 `content-available`과 우선순위 5로 보내되 전달을 기대하지 않는다.
7. 페이로드는 4096바이트(토픽 2048바이트) 안에 ID 위주로 담고, Android 채널 중요도는 출시 전에 확정한다.
