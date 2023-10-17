---
layout: post
title: 코치 추천 점수 설계 — 가중치 기반 랭킹과 콘텐츠 기반 필터링
date: 2023-10-17
tags: [nestjs]
description: 사용자 선호와 코치 속성을 비교하는 유사도 점수에 평점·최근성 같은 신호를 정규화해 가중합으로 합치는 추천 점수 설계.
---

**콘텐츠 기반 필터링**(Content-based Filtering)은 아이템의 속성 정보와 사용자의 선호 프로필을 비교해 추천하는 방식이다. 다른 사용자의 행동 데이터가 쌓이지 않아도 동작하므로, 서비스 초기처럼 예약·조회 이력이 적을 때 출발점으로 쓰기 좋다. 여기서는 사용자에게 코치를 추천하는 점수를 "후보 필터링 → 신호별 점수 → 정규화 → 가중합 → 재정렬" 순서로 설계한다.

## 점수의 구조

최종 점수는 0~1 범위로 맞춘 신호들의 **가중합**(weighted sum)이다.

`score = w₁·s₁ + w₂·s₂ + … + wₙ·sₙ` (가중치의 합은 1)

| 신호 | 의미 | 계산 방법 |
|---|---|---|
| 태그 일치도 | 사용자 목표와 코치 전문 분야의 겹침 | 자카드 지수 |
| 선호 유사도 | 수업 방식·강도 선호와 코치 성향의 유사성 | 코사인 유사도 |
| 가격 적합도 | 희망 가격대와의 거리 | 구간 안 1, 벗어날수록 감소 |
| 평점 | 리뷰 기반 품질 | 베이지안 평균 후 정규화 |
| 활동성 | 최근 수업·응답 여부 | 지수 감쇠 |

가중치가 의미를 가지려면 각 신호가 같은 범위에 있어야 한다. 평점(1~5)과 자카드 지수(0~1)를 그대로 더하면 평점이 점수를 지배한다.

## 반드시 지킬 조건은 점수가 아니라 필터로

지역, 수업 가능 여부, 비활성 계정처럼 어기면 추천 자체가 무의미한 조건은 가중치로 다루지 않고 후보 단계에서 제외한다. 점수로 다루면 가중치가 아무리 작아도 다른 신호가 높을 때 조건을 어긴 코치가 상위에 올라온다.

```sql
SELECT c.id, c.price_per_session, c.style_vector, s.bayes_rating, s.last_active_at
FROM coaches c
JOIN coach_stats s ON s.coach_id = c.id
WHERE c.status = 'ACTIVE'
  AND c.region_id = ?
  AND EXISTS (
    SELECT 1 FROM slots sl
    WHERE sl.coach_id = c.id AND sl.status = 'OPEN' AND sl.starts_at > NOW()
  );
```

## 태그 일치도: 자카드 지수

사용자의 목표 태그 집합 A와 코치의 전문 분야 태그 집합 B의 **자카드 지수**(Jaccard index)는 교집합 크기를 합집합 크기로 나눈 값이다.

`J(A, B) = n(A ∩ B) / n(A ∪ B)` (n은 원소 수, 범위 0~1)

```ts
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
```

두 집합이 모두 비면 0/0이 되므로 애플리케이션에서 값을 정해야 한다. 여기서는 0으로 둬서 정보가 없는 코치가 이득을 보지 않게 한다.

자카드 지수는 합집합으로 나누기 때문에 태그를 많이 단 코치가 불리하다. 사용자 목표 하나에 정확히 맞는 코치가 태그 10개를 달면 1/10이 된다. 사용자의 목표를 얼마나 덮는지가 중요하면 `n(A ∩ B) / n(A)`(사용자 기준 재현율)를 함께 쓰거나 대신 쓴다.

태그가 별도 테이블이면 교집합 크기는 SQL로 구한다.

```sql
SELECT ct.coach_id,
       COUNT(*) AS inter,
       tc.tag_count
FROM coach_tags ct
JOIN (
  SELECT coach_id, COUNT(*) AS tag_count FROM coach_tags GROUP BY coach_id
) tc ON tc.coach_id = ct.coach_id
WHERE ct.tag_id IN (?, ?, ?)
GROUP BY ct.coach_id, tc.tag_count;
```

합집합 크기는 사용자 태그 수 + `tag_count` − `inter`로 계산한다.

## 선호 유사도: 코사인 유사도

"강도 높은 수업 선호", "이론 설명 선호"처럼 정도가 있는 선호는 같은 차원의 수치 벡터로 표현하고 **코사인 유사도**(cosine similarity)로 비교한다.

`cos(A, B) = (A · B) / (‖A‖ ‖B‖)`

일반적으로 -1~1 범위지만, 모든 성분이 0 이상이면 0~1이다. 크기가 아니라 방향을 비교하므로 "모든 항목에 5점을 준 사용자"와 "모든 항목에 3점을 준 사용자"의 유사도는 1이 된다.

```ts
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
```

벡터 성분의 단위가 다르면(예: 수업 시간 분 단위와 1~5 척도) 큰 단위의 차원이 결과를 지배한다. 성분은 먼저 같은 척도로 맞추고, 영벡터는 0으로 처리한다.

## 정규화: 최소-최대 스케일링

평점처럼 범위가 다른 신호는 **최소-최대 정규화**(min-max normalization)로 0~1로 옮긴다.

`x′ = (x − min) / (max − min)`

```ts
function minMax(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}
```

주의할 점이 두 가지 있다.

- **min과 max의 기준**: 요청마다 후보 집합 안에서 구하면 같은 코치의 점수가 후보 구성에 따라 바뀐다. 전체 코치 기준이나 고정 범위(평점이면 1~5)로 정하는 편이 해석하기 쉽다.
- **이상치(outlier)**: 리뷰 수처럼 소수가 매우 큰 값을 가지면 나머지가 0 근처로 몰린다. `log(1 + x)`로 먼저 압축하거나, 백분위로 상한을 자른 뒤 정규화한다.

## 평점: 베이지안 평균

리뷰 1개에 5점인 코치와 리뷰 200개에 평균 4.8점인 코치를 단순 평균으로 비교하면 앞 코치가 이긴다. **베이지안 평균**(Bayesian average)은 사전 평균 m을 가진 가상의 리뷰 C개를 더해 이 문제를 줄인다.

`x̄ = (C·m + Σxᵢ) / (C + n)`

- m: 사전 평균. 보통 전체 리뷰의 평균 평점을 쓴다.
- C: 신뢰할 만한 평균을 얻는 데 필요하다고 보는 리뷰 수. 코치당 리뷰 수의 중앙값 정도에서 시작해 조정한다.
- n, Σxᵢ: 해당 코치의 리뷰 수와 평점 합.

리뷰가 적으면 m 쪽으로 당겨지고, 많아질수록 실제 평균에 가까워진다. C = 10, m = 4.2라면 리뷰 1개 5점은 (42 + 5) / 11 ≈ 4.27, 리뷰 200개 평균 4.8은 (42 + 960) / 210 ≈ 4.77이 된다.

```sql
WITH g AS (SELECT AVG(rating) AS m FROM reviews)
SELECT c.id AS coach_id,
       COUNT(r.id) AS review_count,
       (10 * g.m + COALESCE(SUM(r.rating), 0)) / (10 + COUNT(r.id)) AS bayes_rating
FROM coaches c
CROSS JOIN g
LEFT JOIN reviews r ON r.coach_id = c.id
GROUP BY c.id, g.m;
```

`LEFT JOIN`이므로 리뷰가 없는 코치는 m을 받는다. 새 코치가 0점으로 묻히지 않는 효과도 있다.

## 활동성: 지수 감쇠

마지막 활동 이후 경과 시간 t에 대해 반감기(half-life) h를 정하고 지수적으로 줄인다.

`decay(t) = 0.5^(t / h)`

```ts
const HALF_LIFE_DAYS = 14;

function recency(lastActiveAt: Date, now = new Date()): number {
  const days = (now.getTime() - lastActiveAt.getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(days, 0) / HALF_LIFE_DAYS);
}
```

h = 14이면 2주 전 활동은 0.5, 4주 전은 0.25가 된다. 값이 이미 0~1이므로 별도 정규화가 필요 없다.

## 합치기

```ts
function priceFit(budget: { min: number; max: number }, price: number): number {
  if (price >= budget.min && price <= budget.max) return 1;
  const gap = price < budget.min ? budget.min - price : price - budget.max;
  return Math.max(0, 1 - gap / budget.max);   // 예산 상한만큼 벗어나면 0
}

const WEIGHTS = { tag: 0.3, style: 0.2, price: 0.15, rating: 0.25, recency: 0.1 };

function score(user: UserProfile, c: CoachCandidate): number {
  const s = {
    tag: jaccard(user.goalTags, c.tags),
    style: cosine(user.styleVector, c.styleVector),
    price: priceFit(user.budget, c.pricePerSession),
    rating: (c.bayesRating - 1) / 4,   // 1~5 고정 범위 정규화
    recency: recency(c.lastActiveAt),
  };
  return (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[])
    .reduce((sum, k) => sum + WEIGHTS[k] * s[k], 0);
}
```

가중치는 처음에는 기획 의도로 정하지만, 이후 추천 노출 대비 예약 전환율 같은 지표로 비교하며 조정한다. 신호별 점수를 로그로 남겨 두면 "왜 이 코치가 1위인가"를 설명할 수 있고 조정 근거도 된다.

## 콜드 스타트

신규 사용자나 신규 코치처럼 데이터가 부족해 정확한 추천이 어려운 상황을 **콜드 스타트**(cold start)라고 한다.

| 상황 | 대응 |
|---|---|
| 선호 정보가 없는 신규 사용자 | 가입 시 목표·선호를 짧게 묻는다. 응답 전에는 유사도 가중치를 0으로 두고 평점·활동성만으로 정렬한다. |
| 리뷰가 없는 신규 코치 | 베이지안 평균이 사전 평균을 준다. 일정 기간 노출 가산점을 주거나, 상위 목록 일부를 신규 코치에게 배정한다. |
| 태그가 부실한 코치 | 프로필 작성 단계에서 태그 선택을 필수로 받는다. |

## 다양성: 비슷한 코치만 나오지 않게

점수순으로만 자르면 상위가 같은 전문 분야로 채워진다. 단순한 방법은 분야별 노출 개수에 상한을 두는 것이다. 조금 더 일반적인 방법은 **MMR**(Maximal Marginal Relevance)로 재정렬하는 것이다. 이미 고른 목록 S에 대해, 남은 후보 중 다음 값이 가장 큰 것을 하나씩 추가한다.

`λ · score(d) − (1 − λ) · max_{s ∈ S} sim(d, s)`

λ = 1이면 점수순과 같고, 낮출수록 이미 고른 코치와 다른 코치가 올라온다. 유사도 `sim`에는 태그 자카드 지수를 그대로 쓸 수 있다. 후보 수가 k일 때 계산량이 k²에 비례하므로 상위 50~100개 정도로 줄인 뒤 적용한다.

## SQL에서 계산할까, 애플리케이션에서 계산할까

| | SQL | 애플리케이션 |
|---|---|---|
| 적합한 계산 | 필터, 집계(평균·개수), 교집합 크기 | 벡터 연산, 정규화, 가중합, 재정렬 |
| 장점 | 데이터 이동이 적다 | 로직 변경·테스트가 쉽고 신호별 로그를 남기기 쉽다 |
| 단점 | 수식이 바뀔 때마다 쿼리를 고친다 | 후보를 모두 메모리로 가져와야 한다 |

현실적인 분담은 SQL로 후보를 수백 개 이하로 줄이고, 점수 계산과 재정렬은 애플리케이션에서 하는 것이다.

요청마다 다시 계산할 필요가 없는 값은 미리 계산해 둔다. 베이지안 평점, 리뷰 수, 마지막 활동 시각은 사용자와 무관하므로 리뷰 작성이나 수업 종료 시점, 또는 주기적인 배치로 `coach_stats` 테이블에 갱신한다. 반대로 태그 일치도와 선호 유사도는 사용자마다 다르므로 요청 시점에 계산하거나, 사용자 수가 적다면 사용자별 추천 결과를 배치로 만들어 캐시한다.

## 정리

1. 어기면 안 되는 조건은 점수가 아니라 후보 필터로 처리한다.
2. 집합은 자카드 지수, 정도가 있는 선호는 코사인 유사도로 비교한다.
3. 모든 신호를 0~1로 정규화한 뒤 가중합한다. 정규화 기준은 고정 범위나 전체 기준으로 정하고, 이상치는 로그나 상한으로 누른다.
4. 리뷰 수가 적은 평점은 베이지안 평균으로 사전 평균 쪽으로 당긴다.
5. 최근성은 반감기를 정한 지수 감쇠로 표현한다.
6. 상위 목록은 분야 상한이나 MMR로 다양성을 확보한다.
7. 사용자와 무관한 신호는 미리 계산하고, 사용자별 신호만 요청 시점에 계산한다.
