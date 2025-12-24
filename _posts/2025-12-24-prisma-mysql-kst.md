---
layout: post
title: Prisma와 MySQL에서 한국 시간 다루기 — UTC 저장과 KST 저장의 차이, 날짜 경계 계산
date: 2025-12-24
tags: [nestjs]
description: Prisma가 MySQL DATETIME에 시간을 쓰고 읽는 방식, 기본값에 9시간을 더하는 방식을 쓸 때 지켜야 할 조건, 그리고 서울 기준 "오늘"과 "이번 달"을 UTC 범위로 바꿔 조회하는 방법을 정리한다.
---

한국 사용자만 있는 서비스에서는 "DB에 한국 시간으로 넣으면 편하다"는 유혹이 크다. 그래서 스키마 기본값을 `CURRENT_TIMESTAMP + INTERVAL 9 HOUR`로 바꾸거나, 코드에서 `date.setHours(date.getHours() + 9)`를 하는 경우가 많다. 이 방식도 규칙을 모든 경로에 똑같이 적용하면 문제없이 운영할 수 있다. 다만 Prisma가 시간을 다루는 기본 방식과 기준이 달라서, 한 경로라도 규칙을 벗어나면 9시간 또는 18시간이 어긋난 데이터가 섞인다.

MySQL의 `TIMESTAMP`와 `DATETIME` 차이, 세션 `time_zone`의 의미는 [MySQL 시간대 처리](/2022/02/14/mysql-timezone/)에서 다뤘다. 이 글은 Prisma 6과 MySQL 8.0 조합에서 생기는 문제에 집중한다.

## Prisma의 DateTime은 MySQL에서 어떻게 저장되나

Prisma 스키마의 `DateTime`은 MySQL에서 기본적으로 `DATETIME(3)`, 즉 밀리초 정밀도의 `DATETIME`으로 매핑된다. `@db.Timestamp(3)`나 `@db.Date`로 네이티브 타입을 바꿀 수도 있다.

`DATETIME`은 시간대 정보가 없는 "벽시계 값"이다. 반면 JavaScript의 `Date`는 시간대가 없는 "순간(instant)"이다. 둘 사이를 잇기 위해 Prisma는 `Date`를 쓸 때 UTC 기준 값으로 바꿔 넣고, 읽을 때도 컬럼 값을 UTC로 해석해 `Date`를 만든다. Prisma 저장소의 관련 이슈(prisma/prisma#5051)에서도 MySQL `DATETIME`이 DB 시간대와 무관하게 항상 UTC로 채워진다는 동작이 확인되며, Prisma 6 시점에 이를 바꾸는 설정은 없다.

```typescript
await prisma.attempt.create({ data: { solvedAt: new Date('2025-12-24T09:00:00+09:00') } });
// DB 컬럼 값: 2025-12-24 00:00:00.000

const row = await prisma.attempt.findFirstOrThrow();
row.solvedAt.toISOString(); // '2025-12-24T00:00:00.000Z'
```

정리하면 Prisma를 거치는 한 `DATETIME` 컬럼은 **UTC 벽시계 값**이라는 약속 위에서 동작한다. 이 약속을 깨는 값이 들어오면 Prisma는 그것을 알 방법이 없다.

## INTERVAL 9 HOUR 기본값을 쓸 때 주의할 점

다음과 같은 스키마를 보자.

```prisma
model Attempt {
  id        String   @id @default(uuid()) @db.Char(36)
  solvedAt  DateTime?
  createdAt DateTime @default(dbgenerated("(CURRENT_TIMESTAMP + INTERVAL 9 HOUR)"))
  updatedAt DateTime @default(dbgenerated("(CURRENT_TIMESTAMP + INTERVAL 9 HOUR)"))
}
```

MySQL 8.0.13부터 괄호로 감싼 표현식 기본값이 허용되므로 이 DDL 자체는 유효하다. 주의할 점은 값을 만드는 경로가 여러 개일 때 값의 의미가 한 테이블 안에서 갈라질 수 있다는 것이다.

**첫째, 기본값과 애플리케이션 값의 기준이 다르다.** `createdAt`을 생략하면 DB가 `CURRENT_TIMESTAMP + 9시간`을 넣는다. 세션 `time_zone`이 UTC라면 이는 KST 벽시계 값이다. 하지만 `solvedAt`처럼 코드에서 `new Date()`로 넣은 값은 Prisma가 UTC 벽시계 값으로 넣는다. 같은 순간에 만들어진 두 컬럼이 DB에서 9시간 차이가 난다.

**둘째, 읽을 때 이중 보정이 생긴다.** Prisma는 `createdAt`의 KST 벽시계 값도 UTC로 해석한다. 실제로는 한국 시간 09:00에 만든 행이 API에서 `2025-12-24T09:00:00.000Z`로 나가고, 이 값을 클라이언트가 정상적으로 KST로 바꾸면 18:00이 된다.

**셋째, `CURRENT_TIMESTAMP`는 세션 시간대를 따른다.** `NOW()`와 `CURRENT_TIMESTAMP`는 세션 `time_zone` 기준으로 계산된다. 운영 DB는 UTC인데 로컬 개발용 MySQL이 호스트 시간대(KST)를 따르면, 같은 기본값이 로컬에서는 KST+9, 즉 UTC 기준 18시간 앞선 값을 만든다.

**넷째, 갱신 시각은 기본값으로 유지되지 않는다.** `updatedAt`의 `DEFAULT`는 INSERT에만 적용된다. 갱신 시각을 맞추려고 코드에서 `new Date()`를 넣거나 `@updatedAt`으로 바꾸면 그 순간부터 같은 컬럼 안에 KST 값과 UTC 값이 섞인다.

| 값을 만든 곳 | DB 세션 시간대 | 컬럼에 저장된 값(KST 09:00 기준) | Prisma가 읽은 값 |
|---|---|---|---|
| Prisma, `new Date()` | 무관 | `00:00` | `00:00Z`(정확) |
| DB 기본값 `+ INTERVAL 9 HOUR` | UTC | `09:00` | `09:00Z`(9시간 앞섬) |
| DB 기본값 `+ INTERVAL 9 HOUR` | KST | `18:00` | `18:00Z`(18시간 앞섬) |
| 코드에서 `setHours(+9)` 후 저장 | 무관 | `09:00` | `09:00Z`(9시간 앞섬) |

섞인 데이터는 나중에 바로잡기도 어렵다. 어떤 행이 어느 경로로 만들어졌는지 컬럼 값만으로는 알 수 없기 때문이다.

## KST 벽시계로 일관되게 저장하는 방식

반대로 "이 DB의 `DATETIME`은 전부 KST 벽시계 값"이라는 약속을 팀 전체가 지키면 이 방식도 동작한다. 조건은 다음과 같다.

- DB 기본값, 코드에서 넣는 값, `updatedAt` 갱신이 모두 같은 KST 기준으로 값을 만든다. 코드에서 시각을 넣을 때도 9시간을 더한 값을 쓰고, `@updatedAt` 대신 같은 규칙의 값을 직접 넣는다.
- 운영과 로컬 개발 DB의 세션 `time_zone`을 같게 맞춰 `CURRENT_TIMESTAMP` 결과가 환경마다 달라지지 않게 한다.
- Prisma가 읽은 `Date`는 실제 순간이 아니라 "KST 벽시계를 UTC처럼 표기한 값"이라는 점을 응답 경계에서 한 번만 처리한다. 예를 들어 `Z`를 떼고 `+09:00`을 붙여 내보내거나, 클라이언트가 시간대 변환 없이 그대로 표시하게 한다.
- 스키마와 코드에 이 규칙을 주석으로 남겨 새로 합류한 사람이 `new Date()`를 그대로 넣지 않게 한다.

이렇게 하면 DB를 직접 조회할 때 값이 곧 한국 시간이라 운영과 디버깅이 편하다는 장점이 있다. 대신 규칙이 코드 전체에 퍼져 있어 한 곳만 어겨도 데이터가 섞이고, 다른 시간대 사용자가 생기면 다시 바꿔야 한다. 이 글에서 UTC 저장을 기본으로 권하는 이유는 이 규칙을 사람이 지키는 대신 Prisma의 기본 동작에 맡길 수 있기 때문이다.

## 원칙: UTC로 저장하고 경계에서 변환한다

해결은 단순하다. DB에는 UTC 순간만 저장하고, 사람이 읽는 시간대 변환은 입력과 출력 경계에서만 한다.

```prisma
model Attempt {
  id        String    @id @default(uuid()) @db.Char(36)
  solvedAt  DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

Prisma 6 스키마 레퍼런스에 따르면 관계형 DB에서 `now()`는 DB 수준에서 구현되고 `@updatedAt`은 Prisma Client가 값을 채운다. 그래서 문서는 4.4.0 이전 버전에서 DB와 앱의 시간대가 다르면 두 값이 어긋날 수 있다고 경고한다. 어느 쪽이 값을 만들든 같은 기준이 되도록 DB의 `time_zone`도 UTC로 둔다. `'+00:00'` 같은 오프셋 표기는 MySQL 시간대 테이블을 로드하지 않아도 동작한다.

```sql
SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();
SET GLOBAL time_zone = '+00:00';
```

이미 `+ INTERVAL 9 HOUR`로 쌓인 데이터는 경로를 알 수 있는 컬럼만 옮긴다. 예를 들어 `createdAt`을 코드에서 한 번도 직접 넣은 적이 없다면 그 컬럼은 전부 DB 기본값이므로 일괄로 9시간을 뺄 수 있다. 섞였을 가능성이 있는 컬럼은 생성 로그나 다른 컬럼과의 관계로 판별한 뒤 이관한다.

```sql
UPDATE attempt SET created_at = created_at - INTERVAL 9 HOUR WHERE created_at < '2025-12-24 00:00:00';
```

## "오늘"은 서울의 오늘이다

UTC로 저장하면 "오늘 푼 문제"를 조회할 때 경계 계산이 필요하다. 서울의 2025-12-24는 UTC로 `2025-12-23T15:00:00Z`부터 `2025-12-24T15:00:00Z` 직전까지다. 서버 프로세스의 로컬 시간대(컨테이너는 보통 UTC)로 `new Date(y, m, d)`를 만들면 이 경계가 서버 위치에 따라 달라진다.

dayjs는 `utc`와 `timezone` 플러그인으로 이름 있는 시간대를 다룬다. `timezone` 플러그인은 `utc` 플러그인에 의존하고, 시간대 데이터는 별도로 번들하지 않고 런타임의 국제화 API(Intl)를 쓴다.

```typescript
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const SERVICE_TZ = 'Asia/Seoul';

export function dayRange(date?: string) {
  const ymd = date ?? dayjs().tz(SERVICE_TZ).format('YYYY-MM-DD');
  const start = dayjs.tz(ymd, SERVICE_TZ);
  return { gte: start.toDate(), lt: start.add(1, 'day').toDate() };
}

export function monthRange(ym: string) {
  const start = dayjs.tz(`${ym}-01`, SERVICE_TZ);
  return { gte: start.toDate(), lt: start.add(1, 'month').toDate() };
}
```

```typescript
const today = dayRange();
const count = await prisma.attempt.count({
  where: { userId, solvedAt: today },
});
```

`dayjs.tz('2025-12-24', 'Asia/Seoul')`은 "서울의 2025-12-24 00:00"이라는 순간을 만들고, `toDate()`는 그 순간을 `Date`로 돌려준다. Prisma는 이를 UTC로 바꿔 쿼리에 넣으므로 `solved_at >= '2025-12-23 15:00:00' AND solved_at < '2025-12-24 15:00:00'`이 된다. 범위는 반열린 구간 `[gte, lt)`로 잡는다. `lte: 23:59:59.999` 방식은 정밀도가 바뀌면 경계 값이 빠진다.

`dayjs.tz.setDefault()`로 기본 시간대를 지정해도 `dayjs(value)`는 여전히 로컬 시간대를 쓰고, 기본 시간대는 `dayjs.tz(value)`에만 적용된다. 그래서 위 코드처럼 시간대 이름을 상수로 두고 명시적으로 넘기는 편이 오해가 적다.

## 서머타임이 없어도 이름을 쓴다

한국은 현재 서머타임(DST)을 쓰지 않으므로 `+09:00` 고정 오프셋과 `Asia/Seoul`은 지금 날짜에서 같은 결과를 낸다. 그래도 코드에는 IANA 시간대 이름을 쓴다.

| 표기 | 장점 | 단점 |
|---|---|---|
| `+09:00` 고정 오프셋 | 시간대 데이터 없이 동작 | 과거 서머타임 기간이나 규칙 변경을 반영하지 못함 |
| `Asia/Seoul` | 시간대 데이터베이스의 규칙을 그대로 따름 | 런타임에 시간대 데이터가 필요 |

이름을 쓰면 해외 사용자를 받게 되어 사용자별 시간대를 저장할 때도 같은 함수에 `SERVICE_TZ` 대신 사용자 시간대를 넘기기만 하면 된다. 1980년대 한국처럼 과거에 서머타임을 시행한 기간의 생년월일·기록을 다룰 때도 오프셋이 자동으로 맞는다.

## API 응답 형식

응답에는 오프셋이 있는 ISO 8601 문자열을 쓴다. NestJS가 `Date`를 JSON으로 직렬화하면 `toISOString()` 결과인 `2025-12-24T00:00:00.000Z`가 나간다. 이것만으로도 순간은 정확하므로 클라이언트가 자기 시간대로 바꿔 보여 주면 된다.

| 필드 성격 | 형식 예 | 이유 |
|---|---|---|
| 순간(풀이 시각, 생성 시각) | `2025-12-24T00:00:00.000Z` | 어느 시간대에서든 같은 순간으로 해석 |
| 화면용 현지 시각이 필요할 때 | `2025-12-24T09:00:00+09:00` | 순간과 현지 표기를 동시에 전달 |
| 날짜 자체(생년월일, 학습일) | `2025-12-24` | 시간대 변환 대상이 아님 |

날짜 자체를 뜻하는 값을 `Date`로 다루면 변환 과정에서 하루가 밀린다. 생년월일이나 "학습한 날" 같은 값은 `@db.Date` 컬럼에 담거나 `YYYY-MM-DD` 문자열로 주고받는다. 요청 쪽에서도 클라이언트가 `date=2025-12-24`처럼 날짜만 보내고, 서버가 `dayRange()`로 서울 기준 범위를 계산하게 하면 클라이언트 기기 시간대가 결과에 끼어들지 않는다.

## 방식 비교

| 방식 | 저장 값 | Prisma와의 정합성 | 경계 계산 | 다중 시간대 확장 |
|---|---|---|---|---|
| DB 기본값 `+ INTERVAL 9 HOUR`만 적용 | KST 벽시계(일부만) | 깨짐, 경로별로 섞임 | 쉬워 보이지만 데이터가 틀림 | 불가 |
| 모든 경로를 KST 벽시계로 통일 | KST 벽시계 | 규칙을 지키는 동안 유지, 응답 경계에서 오프셋 보정 필요 | 쉬움, DB 값 그대로 사용 | 어려움 |
| 코드에서 `+9시간` 후 저장 | KST 벽시계 | 깨짐, 읽을 때 이중 보정 | 서버 시간대에 의존 | 불가 |
| UTC 저장 + 경계 변환 | UTC 순간 | 일치 | dayjs로 명시적 계산 | 시간대 인자만 교체 |

## 정리

1. Prisma는 MySQL `DATETIME(3)`을 UTC 벽시계 값으로 읽고 쓴다. 이 약속과 다른 값을 넣으면 Prisma는 구분하지 못한다.
2. `CURRENT_TIMESTAMP + INTERVAL 9 HOUR` 기본값은 애플리케이션이 쓴 값과 기준을 맞추지 않으면 같은 테이블에 9시간·18시간 어긋난 데이터를 섞는다. 모든 경로를 KST로 통일하면 운영할 수 있지만 그 규칙을 팀이 계속 지켜야 한다.
3. 새로 시작한다면 스키마는 `@default(now())`와 `@updatedAt`을 쓰고, DB `time_zone`도 `'+00:00'`으로 맞춘다.
4. "오늘", "이번 달"은 `dayjs.tz(ymd, 'Asia/Seoul')`로 서울 기준 시작 순간을 구한 뒤 `[gte, lt)` UTC 범위로 조회한다.
5. 서머타임이 없어도 고정 오프셋 대신 `Asia/Seoul` 같은 시간대 이름을 쓴다.
6. 응답은 오프셋이 붙은 ISO 8601로 내보내고, 날짜 자체는 `YYYY-MM-DD`로 다룬다.
