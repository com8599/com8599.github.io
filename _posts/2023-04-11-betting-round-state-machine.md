---
layout: post
title: 베팅 라운드를 상태 머신(State Machine)으로 모델링하기
date: 2023-04-11
tags: [game-server]
description: 홀덤 베팅 라운드를 상태, 이벤트, 가드, 타임아웃 전이로 나눠 서버가 규칙을 강제하도록 만드는 방법.
---

포커 베팅 로직을 `if` 문으로 쌓아 가면 금방 "지금 체크가 가능한가", "누구 차례인가", "라운드가 끝났는가" 같은 판단이 핸들러마다 흩어진다. 그 결과 차례가 아닌 플레이어의 액션이 통과하거나, 타이머가 이미 끝난 턴에 폴드를 적용하는 버그가 생긴다.

상태 머신(state machine)은 이 문제를 구조로 해결한다. 게임은 항상 정해진 상태 중 하나에 있고, 상태를 바꾸는 방법은 **이벤트를 전이 함수에 넣는 것** 하나뿐이다. 전이 함수는 가드(guard)로 이벤트의 유효성을 검사하고, 통과하면 다음 상태를 반환한다.

## 상태와 전이

텍사스 홀덤 한 핸드는 다음 단계를 거친다.

| 상태 | 진입 시 처리 | 다음 상태 |
|---|---|---|
| 프리플랍(preflop) | 블라인드, 홀 카드 2장 | 플랍 |
| 플랍(flop) | 커뮤니티 카드 3장 | 턴 |
| 턴(turn) | 커뮤니티 카드 1장 | 리버 |
| 리버(river) | 커뮤니티 카드 1장 | 쇼다운 |
| 쇼다운(showdown) | 핸드 평가, 팟 분배 | 종료 |
| 종료(complete) | 결과 기록 | 다음 핸드 |

각 베팅 스트리트(street) 안에서 일어나는 전이는 세 종류다.

- **턴 이동**: 액션이 유효하고 아직 행동할 플레이어가 남았으면 다음 플레이어에게 차례가 넘어간다.
- **스트리트 종료**: 남은 모든 플레이어가 같은 금액을 냈거나 올인했으면 다음 스트리트로 간다. 더 행동할 수 있는 플레이어가 한 명 이하라면 남은 카드를 모두 깔고 바로 쇼다운으로 간다.
- **핸드 종료**: 한 명만 남고 모두 폴드하면 쇼다운 없이 그 플레이어가 팟을 가져간다.

## 행동 순서

차례는 시계 방향으로 돌지만 시작 위치가 스트리트마다 다르다.

| 상황 | 첫 행동자 |
|---|---|
| 프리플랍 | 빅 블라인드 왼쪽 (UTG, under the gun) |
| 플랍 이후 | 딜러 버튼 왼쪽의 첫 번째 남은 플레이어 |
| 헤즈업(heads-up) 프리플랍 | 딜러 (딜러가 스몰 블라인드를 낸다) |
| 헤즈업 플랍 이후 | 딜러가 아닌 플레이어 (딜러는 마지막) |

프리플랍에서는 빅 블라인드에게 옵션이 있다. 모두 콜만 해서 차례가 빅 블라인드로 돌아오면, 빅 블라인드는 이미 금액을 맞췄더라도 체크하거나 레이즈할 수 있다. 그래서 "금액이 모두 같으면 라운드 종료"라는 조건만으로는 부족하고, **아직 행동하지 않은 플레이어 목록**을 따로 관리해야 한다.

## 판별 유니온(discriminated union)으로 상태 정의

TypeScript의 판별 유니온을 쓰면 상태마다 존재하는 필드가 타입으로 구분된다. `phase`를 확인하기 전에는 `toAct`나 `deadline`에 접근할 수 없으므로, 쇼다운 상태에서 차례를 읽는 실수를 컴파일러가 막아 준다.

```ts
type Street = 'preflop' | 'flop' | 'turn' | 'river';

interface Seat {
  userId: string;
  stack: number;
  committed: number; // 이번 스트리트에 낸 금액
  folded: boolean;
  allIn: boolean;
}

interface Betting {
  phase: 'betting';
  street: Street;
  seats: Seat[];
  button: number;
  bigBlind: number;
  pot: number;
  currentBet: number; // 이번 스트리트의 최고 베팅 총액
  minRaise: number;   // 최소 레이즈 증가분
  pending: number[];  // 아직 행동해야 하는 좌석, 행동 순서대로
  toAct: number;
  deadline: number;   // 서버 기준 epoch ms
  seq: number;        // 상태 버전
}

type HandState =
  | Betting
  | { phase: 'showdown'; seats: Seat[]; pot: number; seq: number }
  | { phase: 'complete'; seats: Seat[]; pot: number; winners: string[]; seq: number };
```

이벤트도 같은 방식으로 정의한다. 플레이어 액션과 타이머 만료는 모두 이벤트이며, 같은 전이 함수를 통과한다.

```ts
type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; to: number }; // 베팅과 레이즈 모두 이번 스트리트 총액으로 표현

type HandEvent =
  | { type: 'action'; seat: number; seq: number; action: PlayerAction }
  | { type: 'timeout'; seat: number; seq: number };

type Result = { ok: true; state: HandState } | { ok: false; reason: string };
```

`raise`의 금액을 증가분이 아니라 "이번 스트리트 총액(raise to)"으로 받으면, 클라이언트와 서버가 같은 숫자를 보고 판단할 수 있어 해석 차이가 줄어든다.

## 전이 함수와 가드

전이 함수는 순수 함수(pure function)로 만든다. 현재 상태와 이벤트, 현재 시각을 받아 결과를 반환할 뿐 소켓 전송이나 타이머 등록 같은 부수 효과는 하지 않는다. 시각을 인자로 받으므로 테스트에서 시간을 자유롭게 지정할 수 있다.

```ts
const TURN_MS = 30_000;

export function transition(state: HandState, event: HandEvent, now: number): Result {
  if (state.phase !== 'betting') return { ok: false, reason: 'NOT_BETTING' };
  if (event.seq !== state.seq) return { ok: false, reason: 'STALE' };
  if (event.seat !== state.toAct) return { ok: false, reason: 'NOT_YOUR_TURN' };

  let action: PlayerAction;
  if (event.type === 'timeout') {
    if (now < state.deadline) return { ok: false, reason: 'EARLY_TIMEOUT' };
    const owed = state.currentBet - state.seats[event.seat].committed;
    action = owed === 0 ? { type: 'check' } : { type: 'fold' };
  } else {
    if (now > state.deadline) return { ok: false, reason: 'TIME_EXPIRED' };
    action = event.action;
  }

  const error = validate(state, event.seat, action);
  if (error) return { ok: false, reason: error };
  return { ok: true, state: advance(apply(state, event.seat, action), now) };
}
```

가드는 위에서부터 차례로 검사한다.

| 가드 | 거절 사유 | 막는 상황 |
|---|---|---|
| `phase`가 betting | `NOT_BETTING` | 쇼다운 이후 들어온 액션 |
| `seq` 일치 | `STALE` | 이전 상태를 보고 보낸 액션, 중복 전송 |
| 차례 확인 | `NOT_YOUR_TURN` | 순서를 무시한 액션 |
| 기한 확인 | `TIME_EXPIRED`, `EARLY_TIMEOUT` | 시간 초과 후 액션, 만료 전 타임아웃 |
| 액션 규칙 | `CANNOT_CHECK` 등 | 규칙 위반 |

액션별 규칙은 별도 함수로 분리한다.

```ts
function validate(s: Betting, seat: number, a: PlayerAction): string | null {
  const p = s.seats[seat];
  const owed = s.currentBet - p.committed;
  switch (a.type) {
    case 'fold':
      return null;
    case 'check':
      return owed === 0 ? null : 'CANNOT_CHECK';
    case 'call':
      return owed > 0 ? null : 'NOTHING_TO_CALL';
    case 'raise': {
      const allInTo = p.committed + p.stack;
      if (!Number.isInteger(a.to)) return 'INVALID_AMOUNT';
      if (a.to > allInTo) return 'INSUFFICIENT_STACK';
      if (a.to <= s.currentBet) return 'RAISE_TOO_SMALL';
      // 노리밋 최소 레이즈: 직전 베팅·레이즈 증가분 이상, 단 올인은 예외
      if (a.to - s.currentBet < s.minRaise && a.to !== allInTo) return 'RAISE_TOO_SMALL';
      return null;
    }
  }
}
```

노리밋(no-limit)에서 최소 레이즈는 직전 베팅 또는 레이즈의 증가분이다. 빅 블라인드가 2이고 누군가 8까지 레이즈했다면 증가분은 6이므로, 다음 리레이즈는 최소 14까지 해야 한다. 스택이 부족한 플레이어는 이보다 적어도 올인할 수 있다.

## 상태 갱신과 라운드 종료 판정

`apply`는 검증된 액션을 반영하고, `advance`는 다음에 무엇이 일어날지 결정한다. 레이즈가 나오면 레이즈한 사람을 제외하고 행동 가능한 모든 플레이어가 다시 `pending`에 들어간다. 콜, 체크, 폴드는 자기 자신을 `pending`에서 뺀다. `pending`이 비면 스트리트가 끝난다.

```ts
const canAct = (p: Seat) => !p.folded && !p.allIn;

function orderFrom(seats: Seat[], start: number): number[] {
  return seats.map((_, k) => (start + k) % seats.length);
}

function apply(s: Betting, seat: number, a: PlayerAction): Betting {
  const seats = s.seats.map((p) => ({ ...p }));
  const p = seats[seat];
  let { pot, currentBet, minRaise } = s;
  let pending = s.pending.filter((i) => i !== seat);

  const put = (amount: number) => {
    p.stack -= amount;
    p.committed += amount;
    pot += amount;
    if (p.stack === 0) p.allIn = true;
  };

  switch (a.type) {
    case 'fold':
      p.folded = true;
      break;
    case 'check':
      break;
    case 'call':
      put(Math.min(currentBet - p.committed, p.stack)); // 스택이 부족하면 올인 콜
      break;
    case 'raise': {
      const raiseBy = a.to - currentBet;
      put(a.to - p.committed);
      if (raiseBy >= minRaise) minRaise = raiseBy;
      currentBet = a.to;
      pending = orderFrom(seats, seat + 1).filter((i) => i !== seat && canAct(seats[i]));
      break;
    }
  }
  return { ...s, seats, pot, currentBet, minRaise, pending };
}

const NEXT: Record<Street, Street | 'showdown'> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: 'showdown',
};

function advance(s: Betting, now: number): HandState {
  const seq = s.seq + 1;
  const alive = s.seats.filter((p) => !p.folded);
  if (alive.length === 1) {
    return { phase: 'complete', seats: s.seats, pot: s.pot, winners: [alive[0].userId], seq };
  }
  if (s.pending.length > 0) {
    return { ...s, toAct: s.pending[0], deadline: now + TURN_MS, seq };
  }

  const seats = s.seats.map((p) => ({ ...p, committed: 0 }));
  const next = NEXT[s.street];
  const pending = orderFrom(seats, s.button + 1).filter((i) => canAct(seats[i]));
  if (next === 'showdown' || pending.length <= 1) {
    return { phase: 'showdown', seats, pot: s.pot, seq };
  }
  return {
    ...s,
    street: next,
    seats,
    currentBet: 0,
    minRaise: s.bigBlind,
    pending,
    toAct: pending[0],
    deadline: now + TURN_MS,
    seq,
  };
}
```

`pending`을 행동 순서대로 유지하므로 다음 차례는 항상 `pending[0]`이다. 프리플랍 시작 시에는 빅 블라인드 왼쪽부터 빅 블라인드까지 모든 플레이어를 `pending`에 넣으면 빅 블라인드 옵션이 자연스럽게 처리된다. 위 코드는 핵심 흐름만 보여 주기 위해 카드 딜링, 사이드 팟(side pot), 그리고 최소 레이즈에 못 미치는 올인이 이미 행동한 플레이어의 레이즈 권한을 다시 열지 않는 규칙을 생략했다. 이런 규칙도 같은 위치, 즉 `validate`와 `apply`에 추가하면 된다.

## 턴 타이머는 타임아웃 전이다

턴 타이머를 클라이언트에 맡기면 안 된다. 클라이언트 시계는 틀릴 수 있고, 조작된 클라이언트는 시간 초과를 보내지 않는다. 타이머는 서버에 있어야 하고, 만료는 플레이어 액션과 똑같이 **이벤트**로 처리한다.

```ts
class TableRunner {
  private timer?: NodeJS.Timeout;

  constructor(private state: HandState, private broadcast: (s: HandState) => void) {}

  dispatch(event: HandEvent): Result {
    const result = transition(this.state, event, Date.now());
    if (!result.ok) return result;
    this.state = result.state;
    this.schedule();
    this.broadcast(this.state);
    return result;
  }

  private schedule() {
    clearTimeout(this.timer);
    const s = this.state;
    if (s.phase !== 'betting') return;
    const seat = s.toAct;
    const seq = s.seq;
    this.timer = setTimeout(
      () => this.dispatch({ type: 'timeout', seat, seq }),
      Math.max(0, s.deadline - Date.now()),
    );
  }
}
```

타임아웃 이벤트도 `seq`를 들고 있다는 점이 중요하다. 단일 프로세스에서는 `clearTimeout`이 이전 타이머를 취소하지만, 취소 처리가 누락되거나 타이머를 작업 큐(job queue)나 다른 프로세스에서 관리하면 이미 지나간 턴의 타임아웃이 뒤늦게 도착할 수 있다. 이 이벤트는 낡은 `seq`를 가지고 있으므로 `STALE`로 거절된다. 타이머를 취소하는 것과 별개로, 가드가 마지막 방어선이 된다. 같은 테이블의 이벤트는 한 번에 하나씩 처리되어야 하므로, 여러 요청이 동시에 들어오는 환경이라면 테이블 단위 직렬화를 함께 적용한다.

클라이언트에는 남은 시간이 아니라 **서버 기준 마감 시각**을 보낸다.

```ts
socket.emit('turn', {
  seq: state.seq,
  toAct: state.toAct,
  deadline: state.deadline, // 서버 epoch ms
  serverNow: Date.now(),
});
```

클라이언트는 수신 시점에 `serverNow - Date.now()`로 자기 시계와 서버 시계의 차이를 구하고, 이를 보정해서 남은 시간을 표시한다. "30초 남음"처럼 상대 시간만 보내면 패킷 지연이나 재연결 후 다시 받은 메시지 때문에 표시가 어긋난다. 마감 시각은 절대값이므로 언제 받아도 같은 의미다. 다만 클라이언트의 카운트다운은 표시용일 뿐이고, 액션이 유효한지는 서버의 `now`와 `deadline` 비교로만 결정된다.

## 잘못된 액션 거절

거절은 예외를 던지는 대신 결과 값으로 반환한다. 거절은 정상적인 흐름의 일부이기 때문이다. 게이트웨이는 거절 사유를 요청한 소켓에만 돌려주고, 상태는 바뀌지 않으므로 다른 플레이어에게는 아무것도 보내지 않는다.

```ts
socket.on('action', (msg: { seq: number; action: PlayerAction }, ack: (r: unknown) => void) => {
  const seat = runner.seatOf(socket.data.userId);
  const result = runner.dispatch({ type: 'action', seat, seq: msg.seq, action: msg.action });
  ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
});
```

클라이언트가 보낸 `seat`는 믿지 않는다. 좌석은 인증된 사용자 ID로 서버가 직접 찾는다. 클라이언트 UI에서 버튼을 비활성화하는 것은 사용성을 위한 것이고, 규칙의 강제는 전적으로 서버의 가드가 맡는다.

## 라이브러리를 쓸 것인가

XState 같은 라이브러리를 쓰면 상태와 전이를 선언적으로 정의하고 상태 차트(statechart)를 시각화할 수 있다. 2023년 현재 안정 버전인 XState v4에서는 `createMachine`으로 머신을 정의하고, 가드는 전이의 `cond` 속성으로 지정한다.

다만 베팅 라운드는 상태 이름 자체보다 플레이어 수, 스택, 현재 베팅액 같은 데이터에 의존하는 판단이 대부분이다. 상태의 종류는 몇 개 안 되고 복잡성은 가드와 데이터 갱신에 몰려 있으므로, 위처럼 판별 유니온과 순수 전이 함수만으로도 충분히 명확하다. 중첩 상태나 병렬 상태가 많은 흐름이라면 라이브러리의 이점이 커진다.

| 항목 | 순수 함수 리듀서 | XState |
|---|---|---|
| 의존성 | 없음 | 라이브러리 |
| 타입 안전성 | 판별 유니온으로 직접 표현 | 라이브러리 타입 정의에 따름 |
| 시각화 | 없음 | 상태 차트 시각화 도구 |
| 중첩·병렬 상태 | 직접 구현 | 기본 지원 |
| 테스트 | 입력과 출력 비교 | 머신 단위 테스트 |
| 적합한 경우 | 데이터 중심 규칙 | 상태 구조가 복잡한 흐름 |

## 정리

| 원칙 | 구현 |
|---|---|
| 상태 변경은 한 곳에서만 | 모든 이벤트가 `transition`을 통과 |
| 상태별 필드 구분 | 판별 유니온 (`phase`) |
| 규칙 강제 | 가드: 단계, `seq`, 차례, 기한, 액션 규칙 |
| 라운드 종료 판정 | 행동 순서대로 정렬한 `pending` 목록 |
| 턴 타이머 | 서버 타이머가 만든 타임아웃 이벤트 |
| 시간 표시 | 서버 기준 마감 시각 전송, 클라이언트는 표시만 |
| 잘못된 액션 | 결과 값으로 거절, 요청자에게만 응답 |

상태 머신으로 모델링하면 "이 상태에서 이 이벤트가 허용되는가"라는 질문에 한 함수가 답하게 된다. 클라이언트가 무엇을 보내든 서버의 전이 함수가 허락하지 않으면 게임 상태는 바뀌지 않는다.
