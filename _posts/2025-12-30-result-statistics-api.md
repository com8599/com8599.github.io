---
layout: post
title: 결과 통계 API — Prisma groupBy, Raw SQL, 집계 테이블 비교
date: 2025-12-30
tags: [nestjs]
description: 학습 결과 화면의 전체·파트별·일별 통계를 Prisma groupBy, 태그드 템플릿 Raw SQL, TypedSQL, 사전 집계 테이블로 각각 구현해 보고 한계와 선택 기준을 정리한다.
---

학습 앱의 결과 화면은 대개 세 층으로 나뉜다. 전체 요약(푼 문항 수, 정답률, 평균 응답 시간), 파트별 결과(훈련 유형별·레벨별 정답률), 그리고 기간 추이(최근 30일 일별 정답률)다. 모두 풀이 이력 테이블 하나에서 나오는 숫자지만, 어떤 도구로 계산하느냐에 따라 코드 양, 타입 안정성, 응답 시간이 크게 달라진다.

예제는 다음 이력 테이블을 기준으로 한다.

```prisma
model Attempt {
  id         String   @id @default(uuid()) @db.Char(36)
  userId     String   @db.Char(36)
  typeCode   String   @db.VarChar(20)
  level      Int
  correct    Boolean
  responseMs Int?
  solvedAt   DateTime @default(now())

  @@index([userId, solvedAt])
}
```

## 필요한 숫자

| 화면 | 그룹 기준 | 값 |
|---|---|---|
| 전체 요약 | 없음 | 문항 수, 정답 수, 정답률, 평균 응답 시간 |
| 파트별 | `typeCode` | 위와 같음 |
| 레벨별 | `typeCode`, `level` | 위와 같음 |
| 일별 추이 | 서울 기준 날짜 | 문항 수, 정답률 |

## Prisma aggregate와 groupBy로 되는 것

전체 요약과 파트별 결과의 일부는 Prisma의 집계 API로 바로 나온다.

```typescript
const byType = await prisma.attempt.groupBy({
  by: ['typeCode'],
  where: { userId, solvedAt: range },
  _count: { _all: true },
  _avg: { responseMs: true },
  orderBy: { typeCode: 'asc' },
});
```

여기서 정답 수가 문제다. `_sum`, `_avg`는 `Int`, `Float` 같은 숫자 필드에만 쓸 수 있으므로 `Boolean`인 `correct`를 더할 수 없다. SQL이라면 `SUM(correct)`나 `SUM(CASE WHEN ... END)` 같은 조건부 집계(Conditional Aggregation) 한 줄이면 되지만, Prisma의 `groupBy`는 집계 대상을 필드 단위로만 받는다. 결국 정답만 필터링한 두 번째 쿼리가 필요하다.

```typescript
const [all, correct] = await Promise.all([
  prisma.attempt.groupBy({
    by: ['typeCode'],
    where: { userId, solvedAt: range },
    _count: { _all: true },
    _avg: { responseMs: true },
  }),
  prisma.attempt.groupBy({
    by: ['typeCode'],
    where: { userId, solvedAt: range, correct: true },
    _count: { _all: true },
  }),
]);
```

그리고 애플리케이션에서 두 결과를 `typeCode`로 맞춰 합친다. 이 방식의 한계를 정리하면 다음과 같다.

| 한계 | 내용 |
|---|---|
| 조건부 집계 불가 | 정답 수·정답률을 한 쿼리로 못 구함 |
| 표현식 그룹 불가 | `by`에는 필드 이름만 들어감. `DATE(solved_at)` 같은 날짜 버킷은 불가 |
| `select` 불가 | 문서상 `groupBy`와 `select`는 함께 쓸 수 없음 |
| `skip`/`take` 제약 | 페이지네이션을 쓰려면 `orderBy`가 필수 |
| 빈 결과 | `_avg`는 행이 없으면 `null`, `_count`는 0 |

반대로 장점도 분명하다. 결과 타입이 생성되고, `where` 조건을 다른 Prisma 쿼리와 공유할 수 있으며, SQL 방언을 신경 쓰지 않아도 된다. 전체 요약과 파트별 결과처럼 필드 단위 그룹이면 `groupBy` 두 번으로 충분하다. `_count`와 `groupBy`의 기본 사용법은 [Prisma 쿼리 최적화](/2023/07/04/prisma-n-plus-one/)에서 다뤘다.

## $queryRaw: 태그드 템플릿으로 한 번에

일별 추이처럼 표현식으로 그룹을 만들어야 하면 Raw SQL을 쓴다. `$queryRaw`를 태그드 템플릿(Tagged Template)으로 호출하면 `${}`로 넣은 값이 문자열로 이어 붙는 것이 아니라 준비된 문장(Prepared Statement)의 바인딩 값으로 전달된다. Prisma 문서도 이 형태에서는 모든 변수를 이스케이프한다고 설명한다.

```typescript
type DailyRow = { day: Date; total: bigint; correct: Prisma.Decimal | null; avgMs: Prisma.Decimal | null };

const rows = await prisma.$queryRaw<DailyRow[]>`
  SELECT DATE(CONVERT_TZ(solved_at, '+00:00', '+09:00')) AS day,
         COUNT(*)                                      AS total,
         SUM(correct)                                  AS correct,
         AVG(response_ms)                              AS avgMs
  FROM attempt
  WHERE user_id = ${userId}
    AND solved_at >= ${range.gte} AND solved_at < ${range.lt}
  GROUP BY day
  ORDER BY day`;

return rows.map((r) => ({
  day: r.day.toISOString().slice(0, 10),
  total: Number(r.total),
  accuracy: Number(r.total) === 0 ? 0 : Number(r.correct ?? 0) / Number(r.total),
  avgMs: r.avgMs === null ? null : Number(r.avgMs),
}));
```

몇 가지 주의점이 있다.

- **타입 매핑**: Prisma 문서 기준 Raw 쿼리 결과의 64비트 정수는 `BigInt`, DECIMAL은 `Decimal`로 온다. MySQL의 `COUNT(*)`는 BIGINT, `SUM`·`AVG`는 DECIMAL을 돌려주므로 그대로 JSON 응답에 넣으면 `BigInt` 직렬화 오류가 난다. 응답 전에 숫자로 바꾼다.
- **제네릭은 검증이 아니다**: `$queryRaw<DailyRow[]>`는 타입 단언일 뿐이다. 컬럼 별칭을 잘못 쓰거나 타입을 잘못 적어도 컴파일은 통과한다.
- **식별자는 바인딩할 수 없다**: 테이블·컬럼 이름이나 `ORDER BY` 방향은 값이 아니므로 `${}`로 넣을 수 없다. `Prisma.raw()`나 `$queryRawUnsafe`로 문자열을 이어 붙이면 SQL 인젝션 위험이 생기므로, 허용 목록에서 고른 상수만 넣는다.
- **조건 조립**: 선택적 필터는 `Prisma.sql`로 조각을 만들고 `Prisma.empty`로 빈 조건을 표현한다. `IN` 목록은 `Prisma.join(ids)`를 쓴다.

```typescript
const typeFilter = typeCode ? Prisma.sql`AND type_code = ${typeCode}` : Prisma.empty;
const sortColumn = { day: Prisma.sql`day`, total: Prisma.sql`total` }[sortKey] ?? Prisma.sql`day`;

const rows = await prisma.$queryRaw`
  SELECT DATE(CONVERT_TZ(solved_at, '+00:00', '+09:00')) AS day, COUNT(*) AS total
  FROM attempt
  WHERE user_id = ${userId} ${typeFilter}
  GROUP BY day
  ORDER BY ${sortColumn}`;
```

날짜 버킷은 저장된 UTC 값을 서울 기준으로 바꾼 뒤 `DATE()`를 씌운다. `CONVERT_TZ`에 `'Asia/Seoul'` 같은 이름을 쓰려면 MySQL 시간대 테이블이 로드되어 있어야 하지만, `'+09:00'` 오프셋은 테이블 없이 동작한다. 조회 범위 `range`를 서울 기준으로 만드는 방법은 [Prisma와 MySQL에서 한국 시간 다루기](/2025/12/24/prisma-mysql-kst/)에서 다뤘다.

## TypedSQL: SQL 파일에서 타입 생성

TypedSQL은 Raw SQL의 타입 문제를 해결하려고 Prisma 5.19.0에 추가된 기능이다. 2025년 말 Prisma 6에서도 프리뷰(Preview) 상태라 `previewFeatures`로 켜야 한다.

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["typedSql"]
}
```

`prisma/sql` 디렉터리에 `.sql` 파일을 두고 `prisma generate --sql`을 실행하면, 파일 이름과 같은 함수와 결과 타입이 생성된다. MySQL은 매개변수를 `?`로 쓰고, MySQL 8.0 이상에서는 매개변수 타입을 추론한다. 필요하면 `-- @param` 주석으로 타입을 명시한다.

```sql
-- @param {String} $1:userId
-- @param {DateTime} $2:from
-- @param {DateTime} $3:to
SELECT type_code AS typeCode, level, COUNT(*) AS total, SUM(correct) AS correct
FROM attempt
WHERE user_id = ? AND solved_at >= ? AND solved_at < ?
GROUP BY type_code, level
```

```typescript
import { levelStats } from '@prisma/client/sql';

const rows = await prisma.$queryRawTyped(levelStats(userId, range.gte, range.lt));
```

| 항목 | `$queryRaw` | TypedSQL |
|---|---|---|
| 결과 타입 | 직접 단언 | DB에서 추론해 생성 |
| SQL 위치 | TypeScript 코드 안 | 별도 `.sql` 파일 |
| 동적 조건·컬럼 | `Prisma.sql` 조각으로 가능 | 동적 컬럼 미지원 |
| 생성 조건 | 없음 | `generate --sql` 시 DB 연결 필요 |
| 상태 | 정식 | 프리뷰 |

생성 시점에 DB 연결이 필요하므로 CI에서 클라이언트를 만들 때 마이그레이션이 적용된 DB를 준비해야 한다. 조건이 고정된 통계 쿼리에는 잘 맞고, 필터 조합이 많은 쿼리에는 `$queryRaw`가 유연하다.

## 사전 집계 테이블

위 방법은 모두 요청 때마다 이력을 훑는다. 사용자별로 범위를 좁히고 인덱스를 타면 수천~수만 행은 문제없지만, 기간이 길어지거나 관리자 화면처럼 전체 사용자를 집계하면 비용이 커진다. 이때 집계 결과를 미리 저장해 둔다.

```prisma
model DailyStat {
  userId       String   @db.Char(36)
  date         DateTime @db.Date
  typeCode     String   @db.VarChar(20)
  total        Int      @default(0)
  correct      Int      @default(0)
  sumResponseMs BigInt  @default(0)

  @@id([userId, date, typeCode])
}
```

평균 대신 합계(`sumResponseMs`)와 개수를 저장하는 것이 핵심이다. 평균끼리는 다시 평균 낼 수 없지만 합계와 개수는 일별 행을 더해 주별·월별 평균을 정확히 다시 계산할 수 있다.

**쓰기 시점 갱신**은 이력 INSERT와 같은 트랜잭션에서 집계 행을 증가시킨다. 읽기가 가장 빠르고 항상 최신이지만, 쓰기 경로가 무거워지고 집계 로직을 바꾸면 과거 행을 재계산해야 한다. 집계 행은 사용자별이라 여러 사용자가 같은 행을 두고 경합하지는 않는다. 전체 사용자 합계처럼 한 행에 쓰기가 몰리는 구조라면 [조회수 집계](/2024/07/30/view-count-write-behind/)의 버퍼링 방식을 검토한다.

```typescript
await prisma.$transaction([
  prisma.attempt.createMany({ data: attempts }),
  ...summarize(attempts).map((s) =>
    prisma.dailyStat.upsert({
      where: { userId_date_typeCode: { userId, date: s.date, typeCode: s.typeCode } },
      create: { userId, date: s.date, typeCode: s.typeCode, total: s.total, correct: s.correct, sumResponseMs: s.sumMs },
      update: { total: { increment: s.total }, correct: { increment: s.correct }, sumResponseMs: { increment: s.sumMs } },
    }),
  ),
]);
```

MySQL에서 Prisma `upsert`는 DB 네이티브 upsert로 실행되지 않으므로, 같은 집계 행을 처음 만드는 요청 두 개가 겹치면 한쪽이 `P2002`로 실패할 수 있다. 이 경우 트랜잭션 전체를 재시도한다.

**읽기 시점 갱신**은 지나간 날짜는 바뀌지 않는다는 성질을 이용한다. 요청이 오면 집계 테이블에 없는 과거 날짜만 Raw SQL로 계산해 저장하고, 오늘 데이터는 항상 이력에서 직접 계산한다. 쓰기 경로는 그대로 두면서 반복 조회 비용을 줄일 수 있다. 다만 과거 이력이 수정되거나 늦게 들어오는 경우(오프라인 풀이 동기화 등)에는 해당 날짜를 무효화하는 규칙이 필요하다.

## 인덱스

사용자별 통계는 모두 `user_id = ? AND solved_at` 범위로 시작하므로 `(userId, solvedAt)`이 기본이다. 집계에 쓰는 컬럼까지 인덱스에 넣으면 커버링 인덱스(Covering Index)가 되어 MySQL이 테이블 행을 읽지 않고 인덱스만으로 집계할 수 있다. `EXPLAIN`의 `Extra`에 `Using index`가 보이면 커버링이 된 것이다.

```text
@@index([userId, solvedAt, typeCode, correct, responseMs])
```

인덱스 컬럼이 많아지면 쓰기 비용과 저장 공간이 늘어난다. 이력이 많이 쌓이고 통계 조회가 실제로 느려졌을 때 `EXPLAIN`으로 확인한 뒤 확장한다.

## 방식 비교

| 기준 | Prisma groupBy | `$queryRaw` | TypedSQL | 집계 테이블 |
|---|---|---|---|---|
| 조건부 집계 | 불가(쿼리 분리) | 가능 | 가능 | 저장 시 계산 |
| 날짜 버킷 | 불가 | 가능 | 가능 | 날짜 컬럼으로 해결 |
| 타입 안정성 | 높음 | 단언에 의존 | 생성된 타입 | 높음 |
| 인젝션 위험 | 없음 | 식별자 조립 시 주의 | 낮음 | 없음 |
| 조회 비용 | 이력 스캔 | 이력 스캔 | 이력 스캔 | 집계 행만 읽음 |
| 쓰기 비용 | 없음 | 없음 | 없음 | 증가(쓰기 시점 갱신) |
| 적합한 경우 | 필드 단위 요약 | 동적 필터, 표현식 그룹 | 고정된 복잡한 쿼리 | 긴 기간, 전체 사용자 집계 |

## 정리

1. 필드 단위 그룹(전체·파트별)은 `groupBy`와 `_count`, `_avg`로 충분하지만 조건부 집계와 표현식 그룹은 안 된다.
2. 일별 추이처럼 표현식 그룹이 필요하면 `$queryRaw` 태그드 템플릿을 쓴다. 값은 바인딩되어 안전하고, 식별자는 허용 목록으로만 넣는다.
3. Raw 결과의 `COUNT`는 `BigInt`, `SUM`·`AVG`는 `Decimal`로 오므로 응답 전에 숫자로 변환한다.
4. TypedSQL은 결과 타입을 생성해 주지만 Prisma 6 기준 프리뷰이고 생성 시 DB 연결이 필요하다.
5. 집계 테이블은 평균이 아니라 합계와 개수를 저장하고, 쓰기 시점 갱신과 읽기 시점 갱신 중 데이터 특성에 맞는 쪽을 고른다.
6. 날짜 버킷은 UTC 값을 서울 기준으로 변환한 뒤 자르고, 인덱스는 `(userId, solvedAt)`에서 시작해 필요할 때 커버링으로 확장한다.
