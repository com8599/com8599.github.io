---
layout: post
title: 실시간 통신 방식 비교 — STOMP, Socket.IO, Firebase
date: 2022-03-24
tags: [infra]
description: 연결 유지, 메시지 브로커, 수평 확장 관점에서 세 가지 선택지를 비교한다.
---

서버에서 클라이언트로 변경을 밀어 주는 방법은 여러 가지다. 어떤 것을 고를지는 기능보다 **서버를 여러 대로 늘렸을 때 메시지를 어떻게 전달하는가**에서 갈린다.

## 전송 방식

| 방식 | 특징 |
|---|---|
| Short polling | 주기적 요청. 단순하지만 지연과 낭비가 크다 |
| Long polling | 변경이 생길 때까지 응답을 보류. 연결 재수립 비용 |
| SSE | 서버 → 클라이언트 단방향 스트림. HTTP 기반 |
| WebSocket | 양방향 지속 연결. 별도 프로토콜로 업그레이드 |

## Spring WebSocket + STOMP

STOMP는 WebSocket 위에서 `SUBSCRIBE`, `SEND` 같은 프레임과 목적지(destination) 개념을 제공한다.

```java
@Override
public void configureMessageBroker(MessageBrokerRegistry registry) {
    registry.enableSimpleBroker("/topic");          // 인메모리 브로커
    // registry.enableStompBrokerRelay("/topic");   // 외부 브로커(RabbitMQ 등)
    registry.setApplicationDestinationPrefixes("/app");
}
```

- simple broker는 인스턴스 메모리 안에 구독 정보를 둔다. STOMP 명령 일부(ack, receipt 등)를 지원하지 않고, Spring 문서도 클러스터링에는 맞지 않는다고 명시한다. 서버가 두 대면 A에 연결된 클라이언트는 B가 발행한 메시지를 받지 못한다.
- 확장하려면 RabbitMQ, ActiveMQ처럼 STOMP를 지원하는 외부 브로커로 relay해야 한다. broker relay는 TCP 연결 관리에 Reactor Netty를 쓰므로 해당 의존성을 추가해야 한다.

## Socket.IO

WebSocket 그 자체가 아니라 그 위의 자체 프로토콜이다. 일반 WebSocket 클라이언트로는 접속할 수 없다.

- room, namespace, 자동 재연결, ack를 제공한다.
- 확장 시 `@socket.io/redis-adapter`로 인스턴스 간 브로드캐스트를 공유한다.
- 기본 설정은 HTTP long polling으로 시작해 WebSocket으로 업그레이드하므로, 서버가 여러 대면 로드밸런서에 **sticky session**이 필요하다. 클라이언트를 `transports: ["websocket"]`로 제한하면 sticky session 없이도 동작하지만 long polling 폴백(fallback)은 포기하게 된다.

## Firebase (Realtime Database / Firestore)

클라이언트가 문서를 직접 구독하고, 서버는 Admin SDK로 값을 쓴다.

```js
// 클라이언트 (Firestore, Web v9 모듈형 SDK)
onSnapshot(doc(db, "rooms", roomId), (snap) => render(snap.data()));
```

- 연결, 재연결, 오프라인 캐시를 SDK가 처리한다. 서버 쪽 소켓 인프라가 필요 없다. 단, Firestore의 오프라인 지속성(offline persistence)은 Android/Apple에서는 기본으로 켜져 있지만 Web에서는 기본으로 꺼져 있어 별도로 활성화해야 한다.
- 클라이언트 접근 제어는 Security Rules로 별도 작성해야 한다. Admin SDK는 Security Rules를 우회한다.
- Firestore는 문서 읽기/쓰기/삭제 횟수와 저장 용량, 네트워크 전송량으로 과금된다. 리스너는 결과 집합의 문서가 추가되거나 변경될 때마다 구독자별로 읽기 1회가 과금되므로, 구독자가 많고 변경이 잦으면 비용이 커진다. Realtime Database는 횟수가 아니라 저장 용량과 다운로드 전송량으로 과금된다.
- 데이터 모델과 쿼리가 Firebase에 종속된다.

## 비교

| | STOMP | Socket.IO | Firebase |
|---|---|---|---|
| 운영 대상 | 앱 서버 + 외부 브로커 | 별도 Node 서버 + Redis | 없음(관리형) |
| 확장 방식 | Broker relay | Redis adapter + sticky | 자동 |
| 인증 | 앱 서버 | 앱 서버 | Security Rules |
| 비용 구조 | 인프라 | 인프라 | 사용량 |
| 종속성 | 낮음 | 중간 | 높음 |

## 선택 기준

- 백엔드 인력이 적고 실시간 데이터가 "상태 동기화" 성격이면 Firebase가 운영 부담이 가장 적다. 이때 원본 데이터는 RDB에 두고, Firebase에는 화면이 구독할 상태만 올려 종속 범위를 제한한다.
- 메시지 순서, 서버 측 검증, 게임처럼 서버가 상태의 주인이어야 하는 경우는 STOMP나 Socket.IO처럼 서버가 연결을 직접 다루는 방식이 맞다.
