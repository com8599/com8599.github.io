---
layout: post
title: 카드 셔플의 공정성 — 피셔-예이츠(Fisher-Yates)와 암호학적 난수(CSPRNG)
date: 2023-01-17
tags: [game-server]
description: 셔플이 치우치는 세 가지 원인과 Node.js에서 공정하고 예측 불가능한 셔플을 만드는 방법.
---

카드 게임 서버에서 셔플은 몇 줄짜리 코드지만, 게임의 공정성이 전부 여기에 달려 있다. 셔플이 공정하다는 것은 두 가지를 뜻한다.

1. **균등성**: 52장 덱의 가능한 모든 순열(52!가지)이 같은 확률로 나온다.
2. **예측 불가능성**: 이전 결과나 공개된 정보로 다음 덱을 추측할 수 없다.

균등성은 알고리즘의 문제이고, 예측 불가능성은 난수 생성기의 문제다. 둘 중 하나만 틀려도 셔플은 공정하지 않다.

## 잘못된 셔플 1: 랜덤 비교 함수로 정렬

가장 흔히 보이는 코드다.

```js
const shuffled = deck.sort(() => Math.random() - 0.5);
```

`Array.prototype.sort`는 비교 함수가 일관적(consistent)이라고 가정한다. 같은 두 원소를 비교하면 항상 같은 결과가 나와야 하고, `a < b`이고 `b < c`이면 `a < c`여야 한다(추이성, transitivity). 랜덤 비교 함수는 이 조건을 모두 깨뜨리므로 결과는 명세상 정의되지 않으며, 엔진이 쓰는 정렬 알고리즘에 따라 특정 위치에 특정 원소가 몰리는 편향이 생긴다. 정렬 알고리즘은 원소를 최소한으로 비교하도록 설계되어 있어서, 처음 위치에 있던 원소가 많이 움직이지 않는 경향이 있다. 시간 복잡도도 O(n log n)으로 셔플보다 느리다.

## 잘못된 셔플 2: 전체 범위에서 교환

다음 코드는 그럴듯해 보이지만 균등하지 않다.

```js
for (let i = 0; i < a.length; i++) {
  const j = Math.floor(Math.random() * a.length); // 전체 범위
  [a[i], a[j]] = [a[j], a[i]];
}
```

각 단계에서 n가지 선택이 있으므로 전체 실행 경로는 nⁿ가지다. 그런데 순열은 n!가지이고, n이 3 이상이면 nⁿ은 n!로 나누어떨어지지 않는다. 경로를 순열에 고르게 나눠 줄 수 없으니 일부 순열이 더 자주 나온다.

원소 3개일 때를 세어 보면 다음과 같다.

| 항목 | 값 |
|---|---|
| 실행 경로 수 (3³) | 27 |
| 순열 수 (3!) | 6 |
| 4번 나오는 순열 | 3개 (확률 4/27 ≈ 14.8%) |
| 5번 나오는 순열 | 3개 (확률 5/27 ≈ 18.5%) |

공정하다면 모든 순열이 1/6 ≈ 16.7%여야 한다.

## 피셔-예이츠 셔플

피셔-예이츠 셔플(Fisher-Yates shuffle)은 1938년 Fisher와 Yates가 손으로 하는 방법으로 발표했고, 1964년 Durstenfeld가 컴퓨터용으로 다듬은 형태가 오늘날 쓰인다. Knuth의 『The Art of Computer Programming』에 실려 크누스 셔플(Knuth shuffle)이라고도 부른다.

뒤에서부터 진행하면서, 아직 확정되지 않은 구간 `[0, i]`에서 하나를 골라 `i` 위치와 교환한다.

```ts
function shuffle<T>(items: readonly T[], randomIndex: (n: number) => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1); // 0 <= j <= i
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

정확성은 경로 수로 확인할 수 있다. 첫 단계는 n가지, 다음은 n-1가지, … 마지막은 2가지이므로 전체 경로는 n × (n-1) × … × 2 = n!가지다. 그리고 서로 다른 경로는 서로 다른 순열을 만든다. 경로 수와 순열 수가 같고 일대일로 대응하므로, `randomIndex`가 균등하기만 하면 모든 순열이 정확히 1/n! 확률로 나온다. 시간 복잡도는 O(n)이다.

흔한 실수는 `randomIndex(i + 1)` 대신 `randomIndex(i)`를 쓰는 것이다. 이렇게 하면 원소가 제자리에 남는 경우가 사라져 순환 순열만 나오는 사톨로 알고리즘(Sattolo's algorithm)이 되고, 셔플로서는 틀린 결과가 된다.

## 모듈로 편향(modulo bias)

알고리즘이 맞아도 `randomIndex`가 치우치면 결과가 치우친다. 난수 바이트를 나머지 연산으로 범위에 맞추는 코드가 대표적이다.

```ts
import { randomBytes } from 'node:crypto';

// 편향된 코드: 0~255를 52로 나눈 나머지
const index = randomBytes(1)[0] % 52;
```

256 = 52 × 4 + 48이므로 0~47은 다섯 번씩, 48~51은 네 번씩 대응된다. 앞쪽 카드가 뒤쪽 카드보다 25% 더 자주 뽑힌다.

해결 방법은 거절 샘플링(rejection sampling)이다. 범위의 배수에 해당하는 구간만 받아들이고 나머지 값은 버린 뒤 다시 뽑는다.

```ts
function unbiasedIndex(n: number): number {
  const limit = 256 - (256 % n); // n의 배수 중 256 이하인 최댓값
  while (true) {
    const byte = randomBytes(1)[0];
    if (byte < limit) return byte % n;
  }
}
```

`n = 52`이면 `limit = 208`이고, 0~207만 쓰면 각 값이 정확히 네 번씩 대응된다. 실제로는 이 처리를 직접 구현할 필요가 없다. Node.js의 `crypto.randomInt`가 모듈로 편향을 피하도록 구현되어 있다.

`Math.floor(Math.random() * n)`도 엄밀히 말하면 부동소수점 해상도 때문에 완벽히 균등하지 않지만, 이 경우 더 큰 문제는 다음 절에서 다루는 예측 가능성이다.

## Math.random과 CSPRNG

`Math.random()`은 [0, 1) 범위의 의사 난수(pseudo-random number)를 반환한다. MDN은 이 함수가 암호학적으로 안전한 난수를 제공하지 않으므로 보안과 관련된 용도에 쓰지 말라고 명시한다. V8은 xorshift128+ 알고리즘을 쓰는데, 내부 상태가 128비트에 불과하고 출력 몇 개를 관찰하면 내부 상태를 역산할 수 있는 것으로 알려져 있다.

카드 게임에서 이 문제는 두 갈래로 나타난다.

- **예측**: 공격자가 공개된 카드(커뮤니티 카드, 자기 핸드)로 생성기 상태를 추정하면, 다른 플레이어의 카드와 남은 덱을 계산할 수 있다.
- **도달 불가능한 순열**: 생성기가 만들 수 있는 서로 다른 출력 수열은 내부 상태 수를 넘지 못한다. 52!은 약 2^225.6이므로 모든 순열에 도달하려면 최소 226비트 상태가 필요하다. 128비트 상태로는 가능한 덱의 극히 일부만 나온다.

CSPRNG(Cryptographically Secure Pseudo-Random Number Generator, 암호학적으로 안전한 의사 난수 생성기)는 운영체제의 엔트로피 소스에서 시드를 받고, 출력으로부터 내부 상태나 다음 출력을 추측할 수 없도록 설계되어 있다. Node.js에서는 `crypto` 모듈이 이를 제공한다.

| 항목 | `Math.random()` | `crypto.randomInt()` |
|---|---|---|
| 용도 | 일반 용도 (애니메이션, 시뮬레이션) | 보안이 필요한 난수 |
| 예측 가능성 | 출력으로 상태 추정 가능 | 설계상 추정 불가 |
| 시드 | 엔진이 선택, 사용자 지정 불가 | OS 엔트로피 |
| 정수 범위 변환 | 직접 처리 (편향 주의) | 모듈로 편향 없이 처리 |
| 범위 | [0, 1) 실수 | `min <= n < max` 정수 |
| 도입 버전 | - | Node.js v14.10.0, v12.19.0 |

## Node.js로 구현한 서버 셔플

`crypto.randomInt([min, ]max[, callback])`는 `min` 이상 `max` 미만의 정수를 반환한다. `min`을 생략하면 0이고, `max - min`은 2⁴⁸보다 작아야 하며, 두 값 모두 안전한 정수(safe integer)여야 한다. 콜백을 넘기지 않으면 동기로 동작한다.

```ts
import { randomInt } from 'node:crypto';

const SUITS = ['s', 'h', 'd', 'c'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

export function newDeck(): string[] {
  return SUITS.flatMap((s) => RANKS.map((r) => r + s));
}

export function shuffleDeck(deck: readonly string[]): string[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); // 0 <= j <= i, CSPRNG
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

셔플 위치도 중요하다. 셔플과 덱은 반드시 서버에만 있어야 한다.

- 클라이언트에서 셔플하면 조작된 클라이언트가 원하는 덱을 보낼 수 있다.
- 덱 전체를 클라이언트에 보내면 개발자 도구로 남은 카드를 볼 수 있다. 클라이언트에는 자기 카드와 공개된 카드만 보낸다.
- 덱은 핸드가 시작될 때 한 번 셔플하고, 카드는 덱 앞에서 순서대로 꺼낸다. 카드를 뽑을 때마다 남은 덱에서 무작위로 고르는 방식도 균등하지만, 덱을 미리 고정해 두는 편이 기록과 검증에 유리하다.

균등성은 단위 테스트로 확인할 수 있다. 원소 3~4개짜리 배열을 수십만 번 셔플해서 각 순열의 빈도를 세고, 카이제곱 검정(chi-squared test)으로 균등 분포에서 벗어나는지 본다.

```ts
const counts = new Map<string, number>();
for (let k = 0; k < 600_000; k++) {
  const key = shuffleDeck(['A', 'B', 'C']).join('');
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
// 6가지 순열이 각각 100,000 근처여야 한다
```

## 검증 가능한 셔플: 커밋-공개(commit-reveal)

CSPRNG로 셔플해도 플레이어 입장에서는 "서버가 핸드 도중에 덱을 바꾸지 않았는가"를 확인할 방법이 없다. 커밋-공개 방식은 덱을 미리 해시로 고정해 두고 나중에 공개해서 이를 증명한다.

1. 핸드 시작 시 서버가 덱을 셔플하고 무작위 솔트(salt)를 만든다.
2. `SHA-256(솔트 + 덱 순서)`를 계산해 **커밋(commitment)**으로 플레이어에게 먼저 보낸다.
3. 핸드가 끝나면 솔트와 덱 전체를 공개한다.
4. 플레이어는 같은 해시를 계산해 처음 받은 커밋과 일치하는지 확인한다.

```ts
import { createHash, randomBytes } from 'node:crypto';

export function commitDeck(deck: readonly string[]) {
  const salt = randomBytes(32).toString('hex');
  const commitment = createHash('sha256')
    .update(salt + ':' + deck.join(','))
    .digest('hex');
  return { salt, commitment }; // commitment만 먼저 공개
}

export function verifyDeck(salt: string, deck: readonly string[], commitment: string): boolean {
  const hash = createHash('sha256').update(salt + ':' + deck.join(',')).digest('hex');
  return hash === commitment;
}
```

솔트가 없으면 덱 후보를 해시해서 커밋과 대조하는 식으로 덱을 미리 알아낼 여지가 생긴다. 32바이트 솔트를 붙이면 공개 전에는 커밋에서 덱을 알아낼 수 없다.

커밋-공개가 증명하는 것은 **커밋 이후 덱이 바뀌지 않았다**는 사실뿐이다. 서버가 처음부터 유리한 덱을 골랐는지는 증명하지 못한다. 이를 보완하려면 서버 시드와 플레이어들이 낸 클라이언트 시드를 합쳐 결정적(deterministic)으로 셔플하는 방식을 쓴다. 서버 시드는 커밋으로 먼저 고정하고 클라이언트 시드는 그 뒤에 받으므로, 어느 한쪽도 결과를 단독으로 정할 수 없다. 이때 시드에서 난수열을 만드는 함수도 HMAC-SHA256 같은 암호학적 함수여야 하고, 정수 변환에는 거절 샘플링을 적용해야 한다.

## 정리

| 문제 | 원인 | 대응 |
|---|---|---|
| 정렬 기반 셔플 편향 | 일관성 없는 비교 함수 | 피셔-예이츠 셔플 |
| 전체 범위 교환 편향 | nⁿ 경로가 n!로 나누어떨어지지 않음 | `j`를 `[0, i]`에서만 선택 |
| 모듈로 편향 | 난수 범위가 n의 배수가 아님 | 거절 샘플링, `crypto.randomInt` |
| 예측 가능한 덱 | `Math.random`의 작은 상태, 비암호학적 설계 | CSPRNG (`crypto` 모듈) |
| 클라이언트 조작·노출 | 셔플이나 덱이 클라이언트에 있음 | 서버에서 셔플, 필요한 카드만 전송 |
| 덱 교체 의심 | 검증 수단 없음 | 커밋-공개, 클라이언트 시드 결합 |

공정한 셔플은 균등한 알고리즘(피셔-예이츠), 편향 없는 정수 변환, 예측 불가능한 난수원(CSPRNG), 서버 전용 실행이 모두 갖춰져야 성립한다. 어느 하나가 빠져도 다른 부분의 정확성은 의미가 없다.
