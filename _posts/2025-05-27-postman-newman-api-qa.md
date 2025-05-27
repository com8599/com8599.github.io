---
layout: post
title: 실행 가능한 API 명세 — Postman 컬렉션과 Newman으로 QA 공수 줄이기
date: 2025-05-27
tags: [collab]
description: 읽기만 하는 API 문서를 실행 가능한 Postman 컬렉션으로 바꾸면 회귀 확인, 환경 공유, 인수인계 비용이 어떻게 달라지는지와 그 구성 방법을 정리한다.
---

API 문서가 있어도 QA와 개발자 사이에서는 같은 질문이 반복된다. "이 API 어떤 토큰으로 호출해요?", "스테이징 주소가 바뀌었나요?", "지난번 배포 이후 주문 조회 응답 형식이 바뀐 것 같은데요?" 문서는 무엇을 보내야 하는지 알려 주지만, **실제로 보내 보고 결과가 맞는지 판정하는 일**은 매번 사람이 한다. 회귀 확인 비용은 API 수에 비례해 커지고, 배포가 잦을수록 그 비용을 더 자주 낸다.

이 글은 API 문서를 Postman 컬렉션(Collection)으로 옮겨 "읽는 명세"를 "실행되는 명세"로 바꾸는 방법과, 그 변화가 QA·개발 공수에 어떤 영향을 주는지를 정리한다.

## 읽는 명세와 실행되는 명세

| 항목 | 읽는 문서(위키, 표) | 실행 가능한 컬렉션 |
|---|---|---|
| 요청 예시 | 복사해서 직접 고쳐 보냄 | 저장된 요청을 그대로 실행 |
| 인증 | 토큰 발급 절차를 문서로 설명 | 스크립트가 토큰을 발급해 변수에 저장 |
| 환경 전환 | 주소를 손으로 바꿈 | 환경(Environment)만 바꿔 선택 |
| 기대 결과 | 문장으로 설명 | `pm.test` 단언(Assertion)으로 판정 |
| 회귀 확인 | 사람이 다시 호출하고 눈으로 비교 | 러너나 CI에서 일괄 실행, 실패만 확인 |
| 문서와 구현의 차이 | 누군가 발견할 때까지 모름 | 테스트 실패로 드러남 |

핵심은 마지막 두 줄이다. 기대 결과가 코드로 적혀 있으면 "확인"이 사람의 판단에서 기계의 판정으로 바뀐다. QA는 실패한 항목과 탐색적 테스트에 시간을 쓰고, 개발자는 배포 전에 같은 컬렉션을 돌려 회귀를 먼저 잡는다.

## 컬렉션 구조

컬렉션은 요청의 묶음이고, 그 안에 폴더(Folder)를 둘 수 있다. 폴더를 나누는 기준은 보통 두 가지다.

| 기준 | 예 | 적합한 용도 |
|---|---|---|
| 리소스(도메인)별 | `orders/`, `payments/`, `users/` | 엔드포인트 단위 명세, 개별 API 확인 |
| 시나리오별 | `checkout-happy-path/`, `refund-flow/` | 여러 요청을 순서대로 잇는 회귀 테스트 |

두 용도를 한 컬렉션에 섞으면 실행 순서와 데이터 의존성이 꼬인다. 명세용 컬렉션과 시나리오 컬렉션을 분리하거나, 최소한 폴더 단위로 나눠 시나리오 폴더만 러너로 돌리는 방식이 관리하기 쉽다.

스크립트는 컬렉션, 폴더, 요청 세 수준에 둘 수 있다. 컬렉션 수준 스크립트는 컬렉션의 모든 요청에, 폴더 수준 스크립트는 폴더의 직속 요청마다 실행된다. 공식 문서는 테스트(응답 후) 스크립트가 컬렉션 → 폴더 → 요청 순으로 실행된다고 설명한다. 그래서 "모든 응답은 2초 안에 온다", "에러 응답은 공통 형식을 따른다" 같은 공통 검사는 컬렉션 수준에, 개별 응답 필드 검사는 요청 수준에 둔다.

## 변수와 스코프

Postman 변수는 다섯 가지 스코프(Scope)를 가진다. 같은 이름이 여러 스코프에 있으면 **가장 좁은 스코프의 값**이 쓰인다.

| 스코프(넓은 순) | 용도 |
|---|---|
| 전역(Global) | 워크스페이스 전체에서 쓰는 값. 남용하면 출처를 추적하기 어렵다 |
| 컬렉션(Collection) | 컬렉션 고유 값. API 버전 접두사, 공통 헤더 값 |
| 환경(Environment) | 환경마다 달라지는 값. 기본 주소, 클라이언트 ID |
| 데이터(Data) | 러너에 넘긴 CSV/JSON 파일의 현재 반복(iteration) 값 |
| 로컬(Local) | 스크립트 실행 중에만 존재하는 임시 값 |

요청 URL이나 헤더에서는 변수 이름을 **이중 중괄호로 감싸** 참조한다. 예를 들어 주소 칸에 `baseUrl` 변수를 이중 중괄호로 감싸 넣고 뒤에 `/orders`를 붙이면, 선택한 환경의 `baseUrl` 값으로 치환된다. 스크립트 안에서는 같은 값을 다음처럼 읽고 쓴다.

```javascript
const baseUrl = pm.environment.get('baseUrl');      // 환경 스코프에서만 읽음
const apiPrefix = pm.collectionVariables.get('apiPrefix');
const token = pm.variables.get('accessToken');      // 우선순위에 따라 해석된 값
pm.environment.set('lastOrderId', '...');
```

`pm.variables.get`은 스코프 우선순위를 적용한 결과를 돌려주므로, 값이 어느 스코프에 있는지 신경 쓰지 않고 읽을 때 쓴다. 반대로 쓰기는 `pm.environment.set`처럼 **스코프를 명시**해야 의도한 곳에 값이 남는다.

### 비밀 값은 공유하지 않는다

환경 변수에는 팀과 동기화되는 초기값(Initial value)과 내 Postman에만 남는 현재값(Current value)이 따로 있다. 비밀번호나 클라이언트 시크릿은 초기값을 비워 두고 각자 현재값에만 넣는다. 그래야 워크스페이스를 공유해도 비밀 값이 퍼지지 않는다. Postman Vault처럼 비밀 값을 로컬에만 두고 참조하는 기능도 있다.

저장소에 환경 파일을 커밋할 때도 같은 원칙을 지킨다. 환경 JSON에는 주소와 ID처럼 공개돼도 되는 값만 두고, 시크릿은 CI의 비밀 저장소에서 실행 시점에 주입한다(아래 Newman 절 참고).

## 사전 요청 스크립트로 인증 자동화

토큰이 필요한 API를 수동으로 호출하면 "로그인 요청 실행 → 토큰 복사 → 헤더에 붙여 넣기"를 반복하게 된다. 컬렉션 수준 사전 요청 스크립트(Pre-request Script)에서 토큰을 발급하고 만료 전까지 재사용하면 이 과정이 사라진다.

```javascript
// 컬렉션 수준 Pre-request
const expiresAt = Number(pm.environment.get('tokenExpiresAt') || 0);
const needsToken = Date.now() >= expiresAt - 30000; // 만료 30초 전부터 재발급

if (needsToken) {
  pm.sendRequest({
    url: pm.environment.get('baseUrl') + '/auth/token',
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    body: {
      mode: 'raw',
      raw: JSON.stringify({
        clientId: pm.environment.get('clientId'),
        clientSecret: pm.environment.get('clientSecret'),
      }),
    },
  }, (err, res) => {
    if (err || res.code !== 200) {
      throw new Error('토큰 발급 실패: ' + (err || res.status));
    }
    const body = res.json();
    pm.environment.set('accessToken', body.accessToken);
    pm.environment.set('tokenExpiresAt', String(Date.now() + body.expiresIn * 1000));
  });
}
```

컬렉션의 인증(Authorization) 설정을 Bearer Token으로 두고 토큰 칸에 `accessToken` 변수를 이중 중괄호로 넣으면, 하위 요청은 인증 방식을 "부모에서 상속(Inherit auth from parent)"으로 두기만 하면 된다. 인증 절차가 바뀌어도 고칠 곳은 스크립트 한 군데다.

## pm.test로 기대 결과를 코드로

테스트 스크립트는 응답을 받은 뒤 실행된다. `pm.test`에 이름과 함수를 넘기고, 안에서 `pm.response`와 Chai 문법의 `pm.expect`로 검사한다.

```javascript
pm.test('201 Created', () => {
  pm.response.to.have.status(201);
});

pm.test('응답 형식', () => {
  const body = pm.response.json();
  pm.expect(body).to.have.property('orderId').that.is.a('string');
  pm.expect(body.status).to.eql('PENDING');
  pm.expect(body.items).to.be.an('array').that.is.not.empty;
});

pm.test('응답 시간 2초 이내', () => {
  pm.expect(pm.response.responseTime).to.be.below(2000);
});

// 다음 요청이 쓸 값을 넘긴다
pm.collectionVariables.set('orderId', pm.response.json().orderId);
```

마지막 줄처럼 앞 요청의 결과를 변수로 넘기면 "주문 생성 → 조회 → 취소" 같은 시나리오를 순서대로 연결할 수 있다. 다만 요청 간 의존이 길어질수록 앞 단계 하나의 실패가 뒤를 모두 실패시키므로, 시나리오는 짧게 끊고 각 시나리오가 필요한 데이터를 스스로 만들게 한다.

## 컬렉션 러너와 데이터 파일

컬렉션 러너(Collection Runner)는 컬렉션이나 폴더의 요청을 순서대로 실행하고 테스트 결과를 모아 보여 준다. 반복 횟수와 데이터 파일(CSV 또는 JSON)을 지정하면 같은 요청을 입력만 바꿔 여러 번 돌릴 수 있다. 데이터 파일의 각 행은 데이터 스코프 변수가 된다.

```text
locale,currency,expectedStatus
ko-KR,KRW,201
ja-JP,JPY,201
en-US,XXX,400
```

경계값과 오류 케이스를 표로 관리하면 QA가 테스트 케이스를 추가할 때 스크립트를 고치지 않고 행만 늘리면 된다.

## OpenAPI에서 가져오기

서버가 OpenAPI 문서를 내보낸다면 컬렉션을 손으로 만들 필요가 없다. NestJS에서 OpenAPI JSON을 만드는 방법은 [NestJS에서 OpenAPI(Swagger) 문서 자동화](/2023/08/22/nestjs-openapi/)에서 다뤘다. Postman은 OpenAPI 정의를 가져와(Import) 컬렉션을 생성하며, 변환기(openapi-to-postman)의 주요 옵션은 다음과 같다.

| 옵션 | 값 | 의미 |
|---|---|---|
| 폴더 구성(`folderStrategy`) | Paths(기본) / Tags | 경로 계층 또는 태그 기준으로 폴더 생성 |
| 요청 이름(`requestNameSource`) | Fallback(기본) / URL | `summary`, `operationId` 등으로 이름 결정 |
| 파라미터 생성(`parametersResolution`) | Schema(기본) / Example | 스키마로 가짜 값을 만들지, 예시 값을 쓸지 |

생성된 컬렉션은 "무엇을 보낼 수 있는가"까지만 담는다. 기대 결과(테스트)와 인증 스크립트는 사람이 붙여야 한다. 그래서 OpenAPI에서 다시 생성할 때마다 덮어쓰지 말고, 생성본은 명세 확인용으로 두고 테스트가 붙은 시나리오 컬렉션은 따로 관리하는 편이 안전하다.

## Newman으로 CI에서 실행

Newman은 Postman 컬렉션을 명령줄에서 실행하는 러너다. 6.x 버전은 Node.js 16 이상이 필요하다. 컬렉션과 환경을 JSON으로 내보내 저장소에 두고 실행한다.

```bash
npx newman@6 run collections/checkout.postman_collection.json \
  -e environments/staging.postman_environment.json \
  --env-var "clientSecret=$CLIENT_SECRET" \
  --folder checkout-happy-path \
  -d data/locales.csv \
  --timeout-request 10000 \
  -r cli,junit \
  --reporter-junit-export results/newman.xml
```

| 옵션 | 역할 |
|---|---|
| `-e`, `--environment` | 환경 파일(경로 또는 URL) |
| `--env-var "key=value"` | 환경 변수 주입. 여러 번 지정 가능. 시크릿 주입에 사용 |
| `--folder` | 지정한 폴더나 요청만 실행 |
| `-d`, `--iteration-data` | 반복용 CSV/JSON 데이터 파일 |
| `-n`, `--iteration-count` | 반복 횟수 |
| `--timeout-request` | 요청별 응답 대기 시간(ms) |
| `-r`, `--reporters` | 리포터 목록(쉼표 구분, 공백 없이) |
| `--bail` | 첫 테스트 스크립트 오류에서 실행 중단 |
| `-x`, `--suppress-exit-code` | 실패해도 기본 종료 코드를 덮어씀 |

내장 리포터는 `cli`, `json`, `junit`, `progress`, `emojitrain`이다. `junit` 결과를 CI의 테스트 리포트로 올리면 실패한 테스트 이름이 빌드 화면에 바로 보인다. HTML 보고서가 필요하면 커뮤니티 리포터 `htmlextra`를 따로 설치해 쓴다.

종료 코드가 CI 연동의 핵심이다. Newman CLI는 실행 오류가 있거나 실패한 단언이 하나라도 있으면 종료 코드 1로 끝나고, 모두 통과하면 0으로 끝난다. 따라서 별도 처리 없이 파이프라인 단계가 실패로 표시된다. `-x`는 이 동작을 끄므로, 결과를 보고만 하고 빌드를 막지 않을 단계(예: 야간 탐색 실행)에만 쓴다.

Postman은 같은 역할의 공식 도구로 Postman CLI도 제공한다. Newman은 오픈 소스이고 내보낸 JSON만으로 동작해 Postman 계정 없이 CI에서 돌릴 수 있다는 점이 다르다.

## 공수가 줄어드는 지점

| 작업 | 문서 기반 | 컬렉션 + Newman |
|---|---|---|
| 배포 전 회귀 확인 | QA가 주요 API를 수동 호출 | CI가 매 배포마다 실행, 실패만 확인 |
| 신규 입사자·타 팀 인수인계 | 문서 설명 + 토큰 발급 안내 | 컬렉션과 환경 공유, 시크릿만 개별 입력 |
| 버그 재현 | 요청 내용을 메신저로 주고받음 | 실패한 요청을 그대로 공유해 재실행 |
| 환경 전환(개발·스테이징·운영) | 주소와 키를 손으로 바꿈 | 환경 선택만 바꿈 |
| 명세 변경 감지 | 클라이언트 오류로 뒤늦게 발견 | 응답 형식 단언 실패로 즉시 발견 |

효과가 나려면 컬렉션이 **코드와 같이 리뷰되고 같이 변경**되어야 한다. API를 바꾸는 PR에 컬렉션 변경(내보낸 JSON)과 테스트 수정이 함께 들어가면, 명세·구현·테스트가 한 시점에 맞춰진다.

## 정리

1. API 문서를 컬렉션으로 옮기고 기대 결과를 `pm.test`로 적으면, 회귀 확인이 사람의 판단에서 기계의 판정으로 바뀐다.
2. 명세용(리소스별)과 시나리오용 컬렉션을 나누고, 공통 검사는 컬렉션 수준, 개별 검사는 요청 수준에 둔다.
3. 변수는 가장 좁은 스코프가 이긴다. 읽기는 `pm.variables.get`, 쓰기는 스코프를 명시한다.
4. 인증은 컬렉션 수준 사전 요청 스크립트로 자동화하고, 하위 요청은 부모 인증을 상속한다.
5. 시크릿은 공유 값과 저장소에 두지 않고, 로컬 값이나 CI 비밀 저장소에서 `--env-var`로 주입한다.
6. Newman은 실패한 단언이 있으면 종료 코드 1을 내므로, JUnit 리포터와 함께 CI 단계로 그대로 붙일 수 있다.
