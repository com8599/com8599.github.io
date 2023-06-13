---
layout: post
title: 소켓 재연결과 세션 복구 — Socket.IO Connection State Recovery
date: 2023-06-13
tags: [game-server]
description: Socket.IO 4.6.0의 연결 상태 복구가 동작하는 방식과 한계, 그리고 스냅샷과 시퀀스 번호로 만드는 폴백 전략.
---

모바일 네트워크에서 소켓 연결은 수시로 끊긴다. 와이파이에서 LTE로 바뀌거나, 엘리베이터에 들어가거나, 앱이 잠깐 백그라운드로 가기만 해도 연결이 끊어진다. Socket.IO 클라이언트는 자동으로 재연결하지만, 기본 동작에서 재연결된 소켓은 **완전히 새로운 소켓**이다.

- `socket.id`가 바뀐다.
- 참여했던 룸(room)에서 모두 빠져 있다.
- `socket.data`가 비어 있다.
- 끊겨 있는 동안 서버가 보낸 이벤트는 사라진다.

카드 게임이라면 끊긴 몇 초 사이에 상대의 레이즈, 새로 깔린 플랍, 자기 차례 알림을 놓칠 수 있다. 2023년 2월 릴리스된 Socket.IO 4.6.0은 이 문제를 다루는 연결 상태 복구(Connection State Recovery) 기능을 추가했다.

## 동작 원리

기능을 켜면 서버와 클라이언트는 다음 정보를 주고받는다.

1. 연결 시 서버가 클라이언트에 **세션 ID**를 보낸다.
2. 서버가 보내는 이벤트 패킷마다 **오프셋(offset)**이 붙고, 클라이언트는 마지막으로 처리한 오프셋을 기억한다.
3. 예기치 않게 연결이 끊기면 서버는 그 소켓의 `id`, 룸 목록, `data`를 일정 시간 보관하고, 그동안 보낸 패킷도 어댑터에 보관한다.
4. 재연결할 때 클라이언트가 세션 ID와 마지막 오프셋을 보낸다.
5. 서버는 세션이 아직 유효하고 오프셋을 찾을 수 있으면 상태를 되살리고, 그 오프셋 이후 해당 소켓에 전달되었어야 할 패킷을 보낸다.

## 서버 설정

```js
import { Server } from 'socket.io';

const io = new Server(httpServer, {
  connectionStateRecovery: {
    // 세션과 패킷을 보관하는 시간
    maxDisconnectionDuration: 2 * 60 * 1000,
    // 복구에 성공하면 미들웨어를 건너뛸지 여부
    skipMiddlewares: true,
  },
});
```

`connectionStateRecovery` 옵션의 기본값은 `undefined`, 즉 꺼져 있다. 객체를 넘기면 켜지고, 하위 옵션을 생략하면 다음 기본값이 적용된다.

| 옵션 | 기본값 | 의미 |
|---|---|---|
| `maxDisconnectionDuration` | `120000` (2분) | 끊긴 세션과 패킷을 보관하는 최대 시간 (ms) |
| `skipMiddlewares` | `true` | 복구 성공 시 `io.use()` 미들웨어를 다시 실행하지 않음 |

`maxDisconnectionDuration`은 일시적인 끊김을 위한 값이다. 보관 기간 동안 보낸 패킷이 메모리나 저장소에 쌓이므로 `Infinity` 같은 값은 피해야 한다.

`skipMiddlewares: true`는 재연결이 빠른 대신 인증 미들웨어도 건너뛴다. 끊겨 있는 사이에 계정이 차단되거나 토큰이 폐기되었다면 그 사용자가 검사 없이 복귀할 수 있다. 인증 상태가 연결 도중에도 바뀔 수 있는 서비스라면 `false`로 두고 미들웨어를 다시 실행하는 편이 안전하다.

## 복구 여부 확인: socket.recovered

서버와 클라이언트 모두 `socket.recovered` 불리언으로 복구 성공 여부를 알 수 있다. 클라이언트 쪽 속성도 4.6.0에서 추가되었으므로 `socket.io-client`도 4.6.0 이상이어야 한다.

```js
// 서버
io.on('connection', (socket) => {
  if (socket.recovered) {
    // id, 룸, data가 복구됨. 놓친 패킷은 자동 전송됨
  } else {
    // 새 세션이거나 복구 실패
  }
});

// 클라이언트
socket.on('connect', () => {
  if (socket.recovered) {
    // 놓친 이벤트가 곧 도착함
  } else {
    // 새 세션이거나 복구 실패
  }
});
```

복구에 성공해도 서버에서는 `connection` 이벤트가 다시 발생하고 새 `Socket` 객체가 만들어진다. 따라서 이벤트 리스너는 평소처럼 `connection` 핸들러에서 등록하면 되고, 룸은 이미 복구되었으므로 다시 `join`하지 않아도 된다.

## 복구되지 않는 것들

연결 상태 복구는 일시적인 끊김을 위한 최선 노력(best effort) 기능이다. 공식 문서도 복구가 항상 성공하지는 않으므로 상태 동기화를 직접 처리해야 한다고 명시한다. 다음 경우에는 복구되지 않는다.

| 상황 | 이유 |
|---|---|
| 끊긴 시간이 `maxDisconnectionDuration` 초과 | 세션이 만료되어 삭제됨 |
| `socket.disconnect()`로 명시적으로 끊음 | 클라이언트나 서버가 의도적으로 끊은 경우는 세션을 저장하지 않음 |
| 클라이언트가 이벤트를 한 번도 받지 않음 | 오프셋이 없어 복구 요청을 보낼 수 없음 |
| 오프셋이 너무 오래됨 | 보관 기간이 지난 패킷이 정리됨 |
| 서버 프로세스 재시작 (기본 어댑터) | 세션과 패킷이 메모리에만 있음 |
| 복구를 지원하지 않는 어댑터 | 아래 표 참고 |

복구되더라도 모든 이벤트가 재전송되는 것은 아니다.

- **확인 응답(acknowledgement)이 있는 이벤트**: 콜백 함수는 직렬화해서 보관할 수 없으므로 저장되지 않는다.
- **`volatile` 이벤트**: 유실을 허용한다는 뜻이므로 저장되지 않는다.
- **클라이언트가 보낸 이벤트**: 복구 대상은 서버가 보낸 패킷이다. 클라이언트에서 연결이 끊긴 동안 `emit`한 이벤트는 기본적으로 클라이언트 버퍼에 쌓였다가 재연결 후 한꺼번에 전송된다. 오래된 액션이 뒤늦게 서버에 도착할 수 있으므로 서버는 상태 버전으로 이를 거절해야 한다.
- **서버 메모리의 게임 상태**: 복구되는 것은 소켓 자체의 상태(id, 룸, data)와 놓친 패킷뿐이다. 애플리케이션 상태는 별개다.

## 어댑터 지원

서버를 여러 대로 늘리면 어댑터가 패킷을 다른 서버로 전달한다. 연결 상태 복구는 패킷을 보관했다가 다시 꺼낼 수 있어야 하므로 어댑터의 지원이 필요하다. 2023년 6월 기준 지원 현황은 다음과 같다.

| 어댑터 | 지원 | 비고 |
|---|---|---|
| 기본 인메모리(in-memory) 어댑터 | 예 | 단일 프로세스 |
| Redis 어댑터 (`@socket.io/redis-adapter`) | 아니요 | Redis Pub/Sub은 메시지를 보관하지 않음 |
| Redis Streams 어댑터 (`@socket.io/redis-streams-adapter`) | 예 | 2023년 4월 첫 릴리스 |
| MongoDB 어댑터 (`@socket.io/mongo-adapter`) | 예 | 0.3.0 이상 |
| Postgres 어댑터 | 아니요 | 지원 예정 |
| Cluster 어댑터 | 아니요 | 지원 예정 |

기존에 Redis 어댑터로 수평 확장하고 있다면, 복구 기능을 쓰려면 Redis Streams 어댑터로 바꿔야 한다. Redis Streams는 메시지를 스트림에 보관하므로 재연결한 클라이언트가 다른 서버에 붙어도 놓친 패킷을 찾을 수 있다.

기본 인메모리 어댑터는 보관 기간 동안 보낸 이벤트 패킷을 메모리 배열에 쌓아 두고 주기적으로 만료된 것을 정리한다. 기능을 켜면 `socket.emit`도 어댑터를 거쳐 저장되므로, 트래픽이 많은 서버에서는 메모리 사용량이 늘어난다는 점을 고려해야 한다.

## 폴백 전략: 권위 있는 스냅샷과 시퀀스 번호

복구는 실패할 수 있으므로, 실패했을 때 상태를 다시 맞추는 경로가 반드시 있어야 한다. 그리고 이 경로가 있으면 복구 기능은 재동기화 비용을 줄이는 최적화가 된다. 게임 서버에서는 다음 두 가지를 조합한다.

1. **시퀀스 번호**: 테이블 상태가 바뀔 때마다 증가하는 번호를 모든 이벤트에 붙인다.
2. **권위 있는(authoritative) 스냅샷**: 서버가 가진 현재 상태를 해당 플레이어 시점으로 걸러서 한 번에 보낸다. 다른 플레이어의 홀 카드나 남은 덱은 포함하지 않는다.

```ts
interface TableEvent {
  tableId: string;
  seq: number; // 테이블 상태 버전
  type: string;
  payload: unknown;
}

interface Snapshot {
  tableId: string;
  seq: number;
  state: PlayerView; // 요청한 플레이어 시점의 상태
}
```

서버는 복구에 실패한 연결을 인증 정보로 다시 식별한다. 재연결 후 `socket.id`는 바뀔 수 있으므로 좌석이나 게임 데이터는 `socket.id`가 아니라 사용자 ID에 묶어 둬야 한다.

```ts
io.on('connection', (socket) => {
  const userId = socket.data.userId; // 인증 미들웨어에서 설정

  if (!socket.recovered) {
    // 룸이 복구되지 않았으므로 사용자 기준으로 다시 참여시킨다
    for (const tableId of tables.findByUser(userId)) {
      socket.join(tableId);
    }
  }

  socket.on('sync', (tableId: string, ack: (s: Snapshot) => void) => {
    ack(tables.get(tableId).snapshotFor(userId));
  });
});
```

`skipMiddlewares: true`로 복구된 경우에도 `socket.data`가 함께 복구되므로 `socket.data.userId`를 그대로 쓸 수 있다.

클라이언트는 마지막으로 적용한 `seq`를 기억하고, 다음 경우에 스냅샷을 요청한다.

- 재연결했지만 `socket.recovered`가 `false`일 때
- 받은 이벤트의 `seq`가 `lastSeq + 1`이 아닐 때 (중간 이벤트 유실)

```ts
let lastSeq = -1;
let syncing = false;

function resync(tableId: string) {
  if (syncing) return;
  syncing = true;
  socket.emit('sync', tableId, (snap: Snapshot) => {
    renderSnapshot(snap.state);
    lastSeq = snap.seq;
    syncing = false;
  });
}

socket.on('connect', () => {
  if (!socket.recovered) resync(currentTableId);
});

socket.on('table-event', (e: TableEvent) => {
  if (e.seq <= lastSeq) return;                 // 이미 반영한 이벤트
  if (e.seq !== lastSeq + 1) return resync(e.tableId); // 유실 감지
  applyEvent(e);
  lastSeq = e.seq;
});
```

`sync` 요청에 확인 응답을 쓰는 이유는 요청과 응답을 짝지을 수 있어서다. 확인 응답이 있는 이벤트는 복구 대상이 아니지만, 스냅샷은 연결된 상태에서 즉시 주고받으므로 문제가 없다. 스냅샷을 기다리는 동안 도착한 이벤트는 스냅샷의 `seq` 이하라면 무시되고, 이후 번호라면 이어서 적용된다. 클라이언트 렌더링이 스냅샷 하나로 전체 화면을 다시 그릴 수 있게 만들어 두면 이 흐름이 단순해진다.

게임 쪽 규칙도 끊김을 고려해야 한다. 연결이 끊긴 플레이어의 좌석은 바로 비우지 않고 일정 시간 유지하며, 턴 타이머는 서버에서 계속 흐른다. 시간이 다 되면 연결 여부와 관계없이 타임아웃 규칙(체크 또는 폴드)이 적용되고, 돌아온 플레이어는 스냅샷으로 그 결과를 받는다.

## 복구와 스냅샷 비교

| 항목 | Connection State Recovery | 스냅샷 재동기화 |
|---|---|---|
| 복구 대상 | 소켓 id, 룸, data, 놓친 서버 패킷 | 애플리케이션 상태 전체 |
| 끊김 허용 시간 | `maxDisconnectionDuration` 이내 | 제한 없음 |
| 서버 재시작 | 어댑터가 외부 저장소일 때만 | 상태 저장소만 있으면 가능 |
| 전송량 | 놓친 패킷만 | 상태 전체 (플레이어 시점) |
| 구현 비용 | 옵션 설정 | 스냅샷, seq 관리 |
| 실패 가능성 | 있음 | 서버 상태가 기준이므로 항상 수렴 |

## 정리

| 항목 | 내용 |
|---|---|
| 도입 버전 | Socket.IO 4.6.0 (2023년 2월), 서버·클라이언트 모두 필요 |
| 설정 | `connectionStateRecovery: { maxDisconnectionDuration, skipMiddlewares }` |
| 기본값 | 2분, `skipMiddlewares: true` |
| 확인 | `socket.recovered` (서버, 클라이언트) |
| 복구 범위 | id, 룸, `data`, 확인 응답과 volatile을 제외한 놓친 서버 이벤트 |
| 어댑터 | 인메모리, Redis Streams, MongoDB(0.3.0+) 지원 / Redis Pub/Sub 미지원 |
| 폴백 | 사용자 ID 기준 재참여, seq 기반 유실 감지, 권위 있는 스냅샷 |

연결 상태 복구는 짧은 끊김을 사용자가 거의 느끼지 못하게 해 주는 좋은 최적화다. 하지만 정확성의 기준은 여전히 서버가 가진 상태이고, 클라이언트는 언제든 스냅샷 하나로 그 상태에 다시 맞출 수 있어야 한다.
