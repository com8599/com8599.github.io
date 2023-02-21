---
layout: post
title: 텍사스 홀덤 핸드 랭킹 평가 알고리즘
date: 2023-02-21
tags: [game-server]
description: 7장 중 최선의 5장을 고르고, 키커까지 포함한 족보를 정수 하나로 인코딩해 비교하는 방법.
---

텍사스 홀덤(Texas hold'em)에서 각 플레이어는 자기 홀 카드 2장과 커뮤니티 카드 5장, 총 7장 중 아무 조합으로나 만들 수 있는 **최선의 5장**으로 승부한다. 홀 카드를 2장 다 써도 되고, 1장만 써도 되고, 하나도 안 써도 된다. 서버는 쇼다운(showdown)마다 이 평가를 해야 하고, 올인(all-in) 상황의 승률 계산이나 시뮬레이션에서는 초당 수백만 번 돌리기도 한다.

평가기의 목표는 하나다. **5~7장을 받아 정수 하나를 반환하고, 정수가 크면 더 강한 핸드, 같으면 무승부가 되게 한다.**

## 핸드 카테고리

표준 52장 덱에서 5장 핸드는 9개 카테고리로 나뉜다. 로열 플러시(royal flush)는 A 하이 스트레이트 플러시일 뿐 별도 카테고리가 아니다.

| 순위 | 카테고리 | 조합 수 | 서로 다른 핸드 수 | 동급 비교 기준 |
|---|---|---|---|---|
| 1 | 스트레이트 플러시 | 40 | 10 | 가장 높은 카드 |
| 2 | 포카드 (four of a kind) | 624 | 156 | 포카드 랭크 → 키커 |
| 3 | 풀하우스 (full house) | 3,744 | 156 | 트리플 랭크 → 페어 랭크 |
| 4 | 플러시 | 5,108 | 1,277 | 5장을 높은 순으로 |
| 5 | 스트레이트 | 10,200 | 10 | 가장 높은 카드 |
| 6 | 트리플 (three of a kind) | 54,912 | 858 | 트리플 → 키커 2장 |
| 7 | 투페어 | 123,552 | 858 | 높은 페어 → 낮은 페어 → 키커 |
| 8 | 원페어 | 1,098,240 | 2,860 | 페어 → 키커 3장 |
| 9 | 하이카드 | 1,302,540 | 1,277 | 5장을 높은 순으로 |
| | 합계 | 2,598,960 | 7,462 | |

"서로 다른 핸드 수"는 무늬만 다르고 강함이 같은 핸드를 하나로 묶은 개수다. 표준 포커에서 무늬 사이에는 서열이 없으므로, 5장 핸드의 강함은 정확히 7,462단계로 나뉜다.

에이스는 스트레이트에서 가장 높은 카드(10-J-Q-K-A)로도, 가장 낮은 카드(A-2-3-4-5)로도 쓸 수 있다. A-2-3-4-5를 휠(wheel)이라 부르며 5 하이 스트레이트로, 가장 약한 스트레이트다. Q-K-A-2-3처럼 A를 사이에 두고 이어지는 형태는 스트레이트가 아니다.

## 키커와 비교

같은 카테고리끼리는 정해진 순서대로 랭크를 비교한다. 예를 들어 원페어끼리는 페어 랭크를 먼저 보고, 같으면 나머지 3장(키커, kicker)을 높은 것부터 하나씩 비교한다.

| 핸드 A | 핸드 B | 결과 | 이유 |
|---|---|---|---|
| K K 9 7 3 | K K 9 6 5 | A 승 | 세 번째 키커 7 > 6 |
| Q Q 5 5 A | Q Q 5 5 K | A 승 | 키커 A > K |
| 7 7 7 2 2 | 7 7 7 K K | B 승 | 풀하우스는 트리플이 같으면 페어로 비교 |
| A 2 3 4 5 | 2 3 4 5 6 | B 승 | 휠은 5 하이 |

7장 평가에서는 "최선의 5장"에 들어가지 않는 카드는 비교에 쓰지 않는다는 점이 중요하다. 보드가 A A K K Q이고 두 플레이어의 홀 카드가 각각 J 9, 8 7이면, 둘 다 최선의 5장은 A A K K Q로 같으므로 무승부다.

## 정수 하나로 인코딩하기

비교 기준이 "카테고리 → 랭크 목록 순서대로"이므로, 이를 자릿수에 그대로 담으면 된다. 랭크는 2~14(A)이므로 4비트(16진수 한 자리)에 들어간다.

| 자리 | 16⁵ | 16⁴ | 16³ | 16² | 16¹ | 16⁰ |
|---|---|---|---|---|---|---|
| 값 | 카테고리 | 1순위 | 2순위 | 3순위 | 4순위 | 5순위 |

K K 9 7 3(원페어)은 카테고리 1, 랭크 목록 [13, 9, 7, 3]이므로 `0x1D9730`이 된다. 높은 자리가 먼저 비교되는 정수의 성질 덕분에 일반 숫자 비교만으로 카테고리와 키커가 사전순(lexicographic)으로 비교된다. 최댓값이 0x8FFFFF 미만이라 JavaScript의 `number`로 충분하다.

```ts
export const Category = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
} as const;

function encode(category: number, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
  return score;
}
```

## 비트마스크로 스트레이트 찾기

랭크 r이 있으면 r번째 비트를 켠 마스크를 만든다. A는 14번 비트에 더해 1번 비트도 켜서 휠을 처리한다. 그러면 스트레이트는 "연속 5비트가 모두 켜져 있는가"라는 비트 연산 하나로 확인할 수 있다.

```ts
interface Card {
  rank: number; // 2..14
  suit: number; // 0..3
}

function rankMask(cards: readonly Card[]): number {
  let mask = 0;
  for (const c of cards) mask |= 1 << c.rank;
  if (mask & (1 << 14)) mask |= 1 << 1; // A를 1로도 취급 (휠)
  return mask;
}

// 가장 높은 스트레이트의 최고 랭크, 없으면 0
function highestStraight(mask: number): number {
  for (let high = 14; high >= 5; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  return 0;
}
```

`high = 5`일 때 `run`은 1~5번 비트이므로 A-2-3-4-5가 잡히고, 반환값 5는 휠이 가장 약한 스트레이트라는 사실까지 그대로 표현한다. 플러시는 무늬별로 카드를 모아 5장 이상인 무늬가 있는지 보면 되고, 그 무늬 카드만으로 `highestStraight`를 다시 돌리면 스트레이트 플러시도 판별된다.

## 7장 평가기

7장에서 5장을 고르는 조합은 C(7,5) = 21가지다. 5장 평가기를 21번 호출해 최댓값을 고르는 방식이 가장 단순하지만, 랭크별 개수와 무늬별 카드만 세면 7장을 한 번에 평가할 수 있다. 강한 카테고리부터 검사하고, 처음 성립하는 카테고리에서 최선의 5장을 구성한다.

```ts
export function evaluate(cards: readonly Card[]): number {
  const counts = new Array<number>(15).fill(0);
  const bySuit: Card[][] = [[], [], [], []];
  for (const c of cards) {
    counts[c.rank]++;
    bySuit[c.suit].push(c);
  }

  // 1. 스트레이트 플러시
  const flushCards = bySuit.find((s) => s.length >= 5);
  if (flushCards) {
    const high = highestStraight(rankMask(flushCards));
    if (high) return encode(Category.StraightFlush, [high]);
  }

  // 랭크를 개수별로 분류 (높은 랭크부터)
  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
  }
  const desc = cards.map((c) => c.rank).sort((a, b) => b - a);
  const kickers = (exclude: number[], n: number) =>
    [...new Set(desc.filter((r) => !exclude.includes(r)))].slice(0, n);

  // 2. 포카드
  if (quads.length) {
    return encode(Category.Quads, [quads[0], ...kickers([quads[0]], 1)]);
  }
  // 3. 풀하우스: 트리플 2개면 낮은 트리플을 페어로 쓴다
  if (trips.length && (trips.length >= 2 || pairs.length)) {
    const pair = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return encode(Category.FullHouse, [trips[0], pair]);
  }
  // 4. 플러시: 해당 무늬에서 높은 5장
  if (flushCards) {
    const top = flushCards.map((c) => c.rank).sort((a, b) => b - a).slice(0, 5);
    return encode(Category.Flush, top);
  }
  // 5. 스트레이트
  const straightHigh = highestStraight(rankMask(cards));
  if (straightHigh) return encode(Category.Straight, [straightHigh]);
  // 6. 트리플
  if (trips.length) {
    return encode(Category.Trips, [trips[0], ...kickers([trips[0]], 2)]);
  }
  // 7. 투페어: 페어가 3개면 세 번째 페어 랭크도 키커 후보가 된다
  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    return encode(Category.TwoPair, [p1, p2, ...kickers([p1, p2], 1)]);
  }
  // 8. 원페어
  if (pairs.length) {
    return encode(Category.Pair, [pairs[0], ...kickers([pairs[0]], 3)]);
  }
  // 9. 하이카드
  return encode(Category.HighCard, kickers([], 5));
}
```

검사 순서에서 놓치기 쉬운 경우들이 있다.

- **트리플 2개**: 7장에서 7 7 7 4 4 4 K가 나오면 트리플만 세면 풀하우스를 놓친다. 낮은 트리플을 페어로 쓴다.
- **페어 3개**: A A 9 9 5 5 K에서 투페어의 키커는 5가 아니라 K다. 반대로 A A 9 9 5 5 2라면 키커는 5다. `kickers`가 남은 랭크 중 가장 높은 것을 고르므로 두 경우가 모두 처리된다.
- **플러시와 스트레이트 동시 성립**: 각각 따로 성립해도 같은 5장이 아니면 스트레이트 플러시가 아니다. 그래서 스트레이트 플러시는 플러시 무늬의 카드만으로 판별한다.
- **풀하우스와 플러시 동시 성립**: 7장에서는 둘 다 가능하므로 풀하우스를 먼저 검사해야 한다.

승자 판정은 점수 최댓값을 가진 플레이어들을 고르면 된다. 여러 명이면 팟을 나눈다(split pot).

```ts
function winners(scores: Map<string, number>): string[] {
  const best = Math.max(...scores.values());
  return [...scores].filter(([, s]) => s === best).map(([id]) => id);
}
```

## 룩업 테이블 방식

위 평가기는 핸드마다 배열과 정렬을 쓰므로 쇼다운 판정에는 충분하지만, 몬테카를로(Monte Carlo) 승률 계산처럼 수억 번 평가해야 하는 경우에는 느리다. 고성능 평가기는 미리 계산한 테이블을 조회하는 방식을 쓴다.

**Cactus Kev 평가기**는 5장 평가기다. 각 카드를 32비트 정수로 표현하는데, 여기에 랭크 비트와 무늬 비트, 랭크별로 할당한 소수(2, 3, 5, 7, 11, …)를 함께 담는다.

- **플러시**: 5장 무늬 비트의 AND가 0이 아니면 플러시다. 랭크 비트를 OR한 13비트 값으로 플러시 테이블을 바로 조회한다.
- **랭크가 모두 다른 비플러시 핸드**(스트레이트, 하이카드): 같은 13비트 값으로 두 번째 테이블을 조회한다.
- **나머지**(페어가 포함된 핸드): 다섯 소수의 곱을 키로 쓴다. 소인수분해의 유일성 때문에 곱은 카드 순서와 무관하게 랭크 구성마다 고유하다. 이 곱을 키로 미리 만든 테이블을 찾는데, 정렬된 배열의 이진 탐색(binary search)이나 퍼펙트 해시(perfect hash)를 쓴다.

결과는 1(로열 플러시)부터 7462(가장 약한 하이카드)까지의 등급이며, 값이 작을수록 강하다. 7장 평가는 21개 조합을 모두 평가해 가장 좋은 값을 고른다.

**Two Plus Two 평가기**는 7장을 직접 다루는 방식으로, 카드 한 장을 넣을 때마다 다음 상태로 넘어가는 거대한 상태 전이 테이블을 미리 만들어 둔다. 7장이면 테이블 조회 7번으로 결과가 나온다. 테이블은 약 3,250만 개의 32비트 정수, 즉 약 130MB에 이르는 대신 평가 자체는 메모리 조회만으로 끝난다.

| 방식 | 평가 비용 | 메모리 | 특징 |
|---|---|---|---|
| 직접 계산 (이 글의 코드) | 개수 세기, 정렬 | 거의 없음 | 이해하기 쉽고 검증이 쉬움 |
| 5장 평가 × 21 조합 | 5장 평가 21회 | 5장 평가기에 따름 | 구현 단순, 7장에서는 비효율 |
| Cactus Kev | 비트 연산 + 테이블 조회 | 수십 KB 규모 | 소수 곱으로 랭크 구성 식별 |
| Two Plus Two | 조회 7회 | 약 130MB | 7장 전용, 매우 빠름 |

게임 서버의 쇼다운 판정은 테이블당 핸드마다 한 번이므로 직접 계산 방식으로 충분하다. 테이블 방식은 승률 표시나 AI 시뮬레이션처럼 대량 평가가 필요할 때 고려한다.

## 테스트

평가기는 경계 사례 위주로 테스트한다.

- 휠(A-2-3-4-5)이 6 하이 스트레이트보다 약한지
- A-K-Q-J-T가 스트레이트, 같은 무늬면 스트레이트 플러시인지
- Q-K-A-2-3이 스트레이트로 판정되지 않는지
- 트리플 2개, 페어 3개 상황
- 보드가 최선의 5장일 때 무승부가 되는지

전수 검증도 가능하다. 5장 조합 2,598,960개를 모두 평가해 카테고리별 개수가 위 표와 일치하고, 서로 다른 점수가 정확히 7,462개인지 확인하면 평가기의 정확성을 강하게 보장할 수 있다.

## 정리

| 요소 | 방법 |
|---|---|
| 최선의 5장 | 강한 카테고리부터 검사, 또는 21개 조합 중 최댓값 |
| 동급 비교 | 카테고리별 랭크 목록을 정해진 순서로 비교 |
| 단일 정수 비교 | 카테고리와 랭크를 16진 자릿수에 배치 |
| 스트레이트 | 랭크 비트마스크에서 연속 5비트 검사 |
| 휠 | A를 1번 비트에도 켜고, 5 하이로 인코딩 |
| 고성능 평가 | Cactus Kev(소수 곱, 13비트 테이블), Two Plus Two(상태 전이 테이블) |

핸드 평가는 "강함을 전순서(total order)로 정렬 가능한 값으로 바꾸는 문제"다. 비교 규칙을 정수의 자릿수 구조에 맞춰 넣으면 나머지 로직은 단순한 숫자 비교가 된다.
