---
layout: post
title: Prisma 쿼리 최적화 — select/include와 N+1 문제
date: 2023-07-04
tags: [nestjs]
description: Prisma에서 N+1이 생기는 경로와 include, in 필터, findUnique 자동 배칭으로 쿼리 수를 줄이는 방법, 그리고 쿼리 로그로 확인하는 법.
---

**N+1 문제**는 목록을 한 번 조회한 뒤(1), 결과의 각 행마다 추가 쿼리를 한 번씩 실행해(N) 전체 쿼리 수가 N+1이 되는 문제다. 쿼리 하나하나는 빠르지만 왕복 횟수가 데이터 양에 비례해 늘어나서, 개발 환경의 적은 데이터로는 드러나지 않다가 운영에서 느려진다. Prisma는 쿼리를 코드로 조립하기 때문에 반복문 안의 `await` 한 줄로도 쉽게 생긴다.

예시 스키마는 코치(`Coach`)와 리뷰(`Review`)의 1:N 관계다.

```prisma
model Coach {
  id      Int      @id @default(autoincrement())
  name    String
  bio     String   @db.Text
  reviews Review[]
}

model Review {
  id        Int      @id @default(autoincrement())
  coachId   Int
  coach     Coach    @relation(fields: [coachId], references: [id])
  rating    Int
  content   String   @db.Text
  createdAt DateTime @default(now())

  @@index([coachId])
}
```

## 반복문이 만드는 N+1

```ts
const coaches = await prisma.coach.findMany();

for (const coach of coaches) {
  const reviews = await prisma.review.findMany({
    where: { coachId: coach.id },
  });
  // ...
}
```

코치가 50명이면 쿼리는 51번 실행된다. `for` 대신 `Promise.all`로 감싸도 쿼리 수는 그대로이고, 동시에 실행될 뿐이다. 동시 실행은 오히려 커넥션 풀을 한꺼번에 점유한다.

## 쿼리 로그로 먼저 확인한다

N+1은 코드만 봐서는 놓치기 쉽다. Prisma Client의 `log` 옵션으로 실제로 실행되는 SQL을 출력해 확인한다.

```ts
const prisma = new PrismaClient({
  log: ['query'],
});
```

실행 시간까지 함께 보거나 특정 조건에서만 기록하려면 이벤트 방식으로 받는다. `emit: 'event'`로 지정한 레벨은 `$on()`으로 구독할 수 있다.

```ts
const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'stdout', level: 'warn' },
    { emit: 'stdout', level: 'error' },
  ],
});

prisma.$on('query', (e) => {
  console.log(`${e.duration}ms ${e.query} ${e.params}`);
});
```

같은 모양의 쿼리가 파라미터만 바뀌어 연속으로 찍히면 N+1이다. 테스트에서 요청 하나당 쿼리 수를 세어 상한을 검사하면 회귀를 막을 수 있다.

## include: 관계를 한 번에 읽기

관계 필드를 `include`로 지정하면 **중첩 읽기**(nested read)가 된다.

```ts
const coaches = await prisma.coach.findMany({
  include: { reviews: true },
});
```

현재 Prisma(4.x)는 이 요청을 SQL `JOIN` 하나로 만들지 않는다. 먼저 코치를 조회하고, 그 결과의 ID를 모아 관계마다 쿼리를 하나씩 더 실행한 뒤 메모리에서 합친다. 쿼리 로그를 간추리면 다음과 같다.

```sql
SELECT `Coach`.`id`, `Coach`.`name`, `Coach`.`bio` FROM `Coach` WHERE 1=1
SELECT `Review`.`id`, `Review`.`coachId`, `Review`.`rating`, `Review`.`content`, `Review`.`createdAt`
  FROM `Review` WHERE `Review`.`coachId` IN (?,?,?,?)
```

코치 수와 상관없이 쿼리는 2번이다. 관계를 한 단계 더 중첩하면 단계마다 쿼리가 하나씩 늘어나지만, 행 수에 비례해 늘지는 않는다. 그래서 `JOIN`이 없어도 N+1은 해결된다. 대신 부모가 많으면 `IN` 목록이 길어지고, 관계 쪽 결과 전체가 애플리케이션 메모리로 올라온다는 점은 염두에 둔다.

`include` 안에서도 관계 목록을 필터링·정렬·제한할 수 있다.

```ts
const coaches = await prisma.coach.findMany({
  include: {
    reviews: {
      where: { rating: { gte: 4 } },
      orderBy: { createdAt: 'desc' },
      take: 3,
    },
  },
});
```

## in 필터: 직접 모아서 조회하기

관계를 다른 서비스 계층에서 조회하거나, 관계로 정의되지 않은 데이터를 붙일 때는 ID를 모아 `in` 필터로 한 번에 조회하고 직접 묶는다. `include`가 내부에서 하는 일을 손으로 하는 셈이다.

```ts
const coaches = await prisma.coach.findMany();
const reviews = await prisma.review.findMany({
  where: { coachId: { in: coaches.map((c) => c.id) } },
});

const byCoach = new Map<number, Review[]>();
for (const r of reviews) {
  const list = byCoach.get(r.coachId) ?? [];
  list.push(r);
  byCoach.set(r.coachId, list);
}

const result = coaches.map((c) => ({ ...c, reviews: byCoach.get(c.id) ?? [] }));
```

묶을 때 `reviews.filter(...)`를 코치마다 호출하면 쿼리 N+1은 사라져도 메모리에서 N×M 탐색이 생긴다. `Map`으로 한 번에 그룹화한다.

## findUnique 자동 배칭과 플루언트 API

Prisma Client에는 내부 데이터로더(dataloader)가 있어서, **같은 틱(tick)**에 발생하고 **같은 `where` 형태와 `include`**를 가진 `findUnique` 쿼리들을 하나의 쿼리로 묶는다. GraphQL처럼 필드마다 리졸버가 따로 실행돼 쿼리를 한곳에 모으기 어려운 구조에서 특히 쓸모가 있다.

관계를 읽을 때는 **플루언트 API**(fluent API)로 `findUnique` 뒤에 관계 이름을 메서드처럼 이어 붙인다.

```ts
// 코치마다 호출되는 리졸버
reviews(coach: Coach) {
  return this.prisma.coach
    .findUnique({ where: { id: coach.id } })
    .reviews();
}
```

리졸버가 코치 수만큼 호출되더라도 같은 틱에 모인 `findUnique`는 `WHERE id IN (...)` 하나로 합쳐지고, 리뷰도 `coachId IN (...)` 쿼리 하나로 조회된다. 단독으로 호출하면 플루언트 API는 쿼리 2번(부모 확인, 관계 조회)이라서 `review.findMany` 한 번보다 많다. 이 방식을 쓰는 이유는 배칭이 `findUnique`에만 적용되고 `findMany`에는 적용되지 않기 때문이다.

배칭은 "같은 틱"이 조건이므로 `for` 문에서 하나씩 `await`하면 묶이지 않는다. 직접 호출할 때는 `Promise.all`로 동시에 시작해야 한다.

| 호출 방식 | 실행 쿼리 수 |
|---|---|
| `for` + `await findUnique` | N |
| `Promise.all` + `findUnique` | 1 (배칭) |
| `Promise.all` + `findMany` | N |

## select: 필요한 필드만

`select`는 반환할 필드를 지정한다. 관계 안에도 중첩할 수 있다.

```ts
const coaches = await prisma.coach.findMany({
  select: {
    id: true,
    name: true,
    reviews: {
      select: { rating: true },
      take: 5,
      orderBy: { createdAt: 'desc' },
    },
  },
});
```

같은 단계에서 `select`와 `include`를 함께 쓸 수는 없다. 관계를 포함하면서 필드를 고르려면 위처럼 `select` 안에 관계를 넣는다.

`select`의 효과는 쿼리 수가 아니라 각 쿼리가 읽어 오는 양에 있다. 컬럼이 적은 테이블이면 모든 필드를 읽어도 성능 차이는 대부분 작다. 차이가 나는 경우는 다음과 같다.

- `bio`, `content`처럼 큰 `TEXT` 컬럼이 있어 행 밖에 따로 저장되는 경우
- 컬럼이 많은 넓은 테이블
- 목록 API처럼 행 수가 많아 응답 크기가 커지는 경우

API 응답에 비밀번호 해시 같은 필드가 섞여 나가는 것을 막는 효과도 있다.

## _count: 개수만 필요할 때

목록에 리뷰 수만 보여 주면서 `include: { reviews: true }`로 리뷰 전체를 읽고 `length`를 세는 것은 낭비다. 3.0.1부터는 `_count`로 관계 개수만 조회할 수 있다.

```ts
const coaches = await prisma.coach.findMany({
  select: {
    id: true,
    name: true,
    _count: { select: { reviews: true } },
  },
});
// [{ id: 1, name: '...', _count: { reviews: 12 } }, ...]
```

평균 평점처럼 개수 이외의 집계가 필요하면 `groupBy`로 한 번에 계산한다.

```ts
const stats = await prisma.review.groupBy({
  by: ['coachId'],
  where: { coachId: { in: coachIds } },
  _avg: { rating: true },
  _count: { _all: true },
});
```

## 정리

| 방법 | 쿼리 수 | 적합한 경우 |
|---|---|---|
| 반복문 안의 `findMany` | N+1 | 쓰지 않는다 |
| `include` | 관계 단계 수 + 1 | 관계로 정의된 데이터를 함께 읽을 때 |
| `in` + `Map` 조립 | 2 | 계층이 나뉘어 있거나 관계가 정의되지 않은 데이터 |
| `findUnique` + 플루언트 API | 2 (배칭) | 리졸버처럼 호출 지점이 흩어져 있을 때 |
| `_count`, `groupBy` | 1 | 관계 데이터가 아니라 집계만 필요할 때 |

1. 개발 중에는 `log: ['query']`를 켜고, 같은 모양의 쿼리가 반복되는지 본다.
2. 반복문 안에서 쿼리를 실행하지 않는다. 먼저 ID를 모은다.
3. `include`는 관계마다 쿼리를 추가로 실행하며, 행 수에 비례해 늘지 않는다.
4. 개수와 평균은 관계 전체를 읽지 말고 `_count`와 `groupBy`로 구한다.
5. `select`는 큰 컬럼과 넓은 테이블, 큰 목록 응답에서 효과가 크다.
