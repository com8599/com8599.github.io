---
layout: post
title: 학습 앱의 진행도 모델링 — 레벨, 세트, 오늘의 과제, 풀이 이력 스키마
date: 2025-12-23
tags: [nestjs]
description: 학습 콘텐츠, 사용자 진행도, 풀이 이력을 서로 다른 성격의 테이블로 나누고, 오늘의 과제를 멱등하게 생성하며, 자주 쓰는 조회에 맞춰 인덱스를 설계하는 방법을 Prisma 스키마로 정리한다.
---

말하기 훈련 앱처럼 문제를 풀며 레벨이 오르는 학습 앱은 세 종류의 데이터를 다룬다. 운영자가 만드는 **콘텐츠**(레벨, 세트, 문항), 사용자마다 하나씩 있는 **현재 상태**(지금 몇 레벨인지, 점수가 얼마인지), 그리고 사용자가 문제를 풀 때마다 쌓이는 **이력**이다. 이 셋은 바뀌는 주기와 쓰기 패턴이 전혀 다르다. 한 테이블에 섞으면 쿼리와 정합성이 동시에 꼬인다.

## 세 종류의 데이터

| 구분 | 예 | 쓰기 주체 | 쓰기 패턴 | 행 수 |
|---|---|---|---|---|
| 콘텐츠 | 레벨 규칙, 문항 세트, 문항 | 운영자 | 가끔 수정 | 수백~수천 |
| 진행도 | 유형별 현재 레벨, 누적 점수 | 서버 | 같은 행을 계속 UPDATE | 사용자 × 유형 |
| 이력 | 문항별 풀이 기록 | 서버 | INSERT만(Append-only) | 계속 증가 |
| 오늘의 과제 | 날짜별 배정된 세트 | 서버 | 하루 한 번 생성 후 상태 갱신 | 사용자 × 일 |

이 구분이 스키마 설계의 기준이 된다. 콘텐츠는 정규화해 한 곳에서 고치고, 진행도는 사용자·유형당 한 행으로 유지하고, 이력은 덮어쓰지 않는다.

## 콘텐츠: 유형, 레벨, 세트, 문항

훈련 유형(단어 따라 말하기, 문장 듣고 고르기 등)마다 레벨 규칙이 있고, 레벨마다 여러 세트, 세트마다 여러 문항이 있다.

```prisma
model TrainingType {
  code   String  @id @db.VarChar(20)
  name   String  @db.VarChar(50)
  levels Level[]
}

model Level {
  typeCode   String       @db.VarChar(20)
  level      Int
  itemCount  Int
  choiceCount Int
  passScore  Int
  type       TrainingType @relation(fields: [typeCode], references: [code])
  sets       ItemSet[]

  @@id([typeCode, level])
}

model ItemSet {
  id       String  @id @default(uuid()) @db.Char(36)
  typeCode String  @db.VarChar(20)
  level    Int
  version  Int     @default(1)
  active   Boolean @default(true)
  levelRef Level   @relation(fields: [typeCode, level], references: [typeCode, level])
  items    Item[]

  @@index([typeCode, level, active])
}

model Item {
  id        String  @id @default(uuid()) @db.Char(36)
  setId     String  @db.Char(36)
  order     Int
  prompt    String  @db.VarChar(200)
  answer    String  @db.VarChar(200)
  audioPath String? @db.VarChar(300)
  set       ItemSet @relation(fields: [setId], references: [id])

  @@unique([setId, order])
}
```

`Level`은 `(typeCode, level)` 복합 기본키를 쓴다. 레벨은 유형 안에서만 의미가 있으므로 별도 대리키보다 자연키가 조회와 외래키 모두에서 읽기 쉽다. 세트에는 `active`를 둬서 문항을 고칠 때 기존 세트를 지우지 않고 새 세트를 활성화한다. 이미 풀린 세트를 지우면 이력이 가리키는 대상이 사라지기 때문이다.

## 진행도: 사용자 × 유형당 한 행

"이 사용자는 문장 유형 3레벨, 단어 유형 5레벨"이라는 상태는 사용자와 유형의 조합마다 정확히 한 행이어야 한다. 복합 기본키로 이를 강제한다.

```prisma
model UserProgress {
  userId    String   @db.Char(36)
  typeCode  String   @db.VarChar(20)
  level     Int      @default(1)
  points    Int      @default(0)
  updatedAt DateTime @updatedAt
  levelRef  Level    @relation(fields: [typeCode, level], references: [typeCode, level])

  @@id([userId, typeCode])
}
```

`(typeCode, level)`을 `Level`의 외래키로 걸어 두면 존재하지 않는 레벨로 올라가는 버그를 DB가 막아 준다. 현재 레벨을 이력에서 매번 계산하는 방식도 가능하지만, 레벨 규칙이 바뀌면 과거 이력으로 재계산한 결과가 달라진다. 진행도는 "규칙을 적용한 결과"를 별도로 저장하는 편이 안전하다.

## 풀이 이력: 덮어쓰지 않는다

이력은 사용자가 어떤 문항을 언제, 어떻게 풀었는지에 대한 사실(fact)이다. 재도전도 새 행으로 남긴다. UPDATE를 허용하면 "처음 틀리고 두 번째에 맞힌" 정보가 사라지고, 통계가 언제 계산했느냐에 따라 달라진다.

```prisma
model Attempt {
  id          String   @id @default(uuid()) @db.Char(36)
  userId      String   @db.Char(36)
  sessionId   String   @db.Char(36)
  itemId      String   @db.Char(36)
  typeCode    String   @db.VarChar(20)
  level       Int
  prompt      String   @db.VarChar(200)
  answer      String   @db.VarChar(200)
  response    String?  @db.VarChar(300)
  correct     Boolean
  responseMs  Int?
  solvedAt    DateTime @default(now())

  @@index([userId, solvedAt])
  @@index([userId, typeCode, solvedAt])
  @@index([sessionId])
}
```

### 콘텐츠를 스냅샷으로 복사한다

`prompt`, `answer`, `level`, `typeCode`는 `Item`에도 있는데 이력에 다시 저장한다. 의도된 중복이다. 운영자가 문항의 정답 표기를 고치거나 세트를 다른 레벨로 옮기면, `itemId` 조인만으로는 "그 당시 사용자가 본 문제"를 재현할 수 없다. 이력에는 풀이 시점의 콘텐츠를 스냅샷(Snapshot)으로 남기고, `itemId`는 원본을 추적하는 참조로만 쓴다.

스냅샷에는 장점이 하나 더 있다. 통계 쿼리가 `Item`, `ItemSet`과 조인하지 않고 `Attempt` 한 테이블에서 끝난다. 유형별·레벨별 정답률을 구할 때 이 차이가 크다.

`itemId`에 외래키를 걸지 않은 것도 의도다. 외래키를 걸면 문항 삭제가 막히거나(`Restrict`) 이력이 함께 지워진다(`Cascade`). 이력은 콘텐츠 수명과 독립적이어야 하므로 참조 무결성 대신 스냅샷으로 의미를 보존한다.

## 오늘의 과제: 하루에 한 번, 몇 번 호출해도 같은 결과

앱을 열 때마다 "오늘의 과제"를 조회한다. 과제가 아직 없으면 사용자의 현재 레벨에 맞는 세트를 골라 배정한다. 이 생성 로직은 같은 날 여러 번 호출되거나, 앱이 동시에 두 요청을 보내도 과제가 하나만 생겨야 한다. 즉 멱등(Idempotent)해야 한다.

```prisma
model DailyAssignment {
  id          String    @id @default(uuid()) @db.Char(36)
  userId      String    @db.Char(36)
  date        DateTime  @db.Date
  typeCode    String    @db.VarChar(20)
  setId       String    @db.Char(36)
  status      String    @default("ASSIGNED") @db.VarChar(20)
  completedAt DateTime?

  @@unique([userId, date])
}
```

`date`는 순간이 아니라 "서울 기준 날짜"이므로 `@db.Date`에 담고, 서버 로컬 시간대가 아니라 `Asia/Seoul` 기준으로 계산한 날짜를 넣는다. 핵심은 `@@unique([userId, date])`다. 애플리케이션 코드가 "있는지 보고 없으면 만든다"를 동시에 두 번 실행해도 DB가 두 번째 INSERT를 막는다.

Prisma는 `Date`를 UTC 기준으로 직렬화하므로 `@db.Date` 컬럼에는 UTC 기준 날짜가 들어간다. 한국 시간 오전 8시에 `new Date()`를 넣으면 전날 날짜가 저장되는 이유다. 그래서 "서울의 오늘"을 구한 뒤 그 날짜의 UTC 자정으로 `Date`를 만든다.

```typescript
function todayInSeoulAsDate(): Date {
  const ymd = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
  return new Date(`${ymd}T00:00:00.000Z`);
}

async getOrCreateToday(userId: string): Promise<DailyAssignment> {
  const date = todayInSeoulAsDate();
  const key = { userId_date: { userId, date } };

  const existing = await this.prisma.dailyAssignment.findUnique({ where: key });
  if (existing) return existing;

  const plan = await this.pickSetFor(userId);
  try {
    return await this.prisma.dailyAssignment.create({
      data: { userId, date, typeCode: plan.typeCode, setId: plan.setId },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return this.prisma.dailyAssignment.findUniqueOrThrow({ where: key });
    }
    throw e;
  }
}
```

`upsert`를 써도 되지만, Prisma 문서 기준 MySQL은 DB 네이티브 upsert 대상이 아니어서 동시 요청에서 `P2002`가 날 수 있고 문서도 이를 잡아 재시도하라고 안내한다. 결국 같은 처리가 필요하므로 위처럼 명시적으로 쓰는 편이 읽기 쉽다. 세트를 고르는 로직에 무작위성이 있어도 먼저 커밋된 배정이 그날의 정답이 되므로 결과가 바뀌지 않는다.

배치로 자정에 모든 사용자의 과제를 미리 만드는 방법도 있다. 다만 활동하지 않는 사용자의 행까지 만들고, 배치가 실패하면 그날 과제가 없다. 요청 시 생성(Lazy Creation)은 필요한 행만 만들고, 배치를 함께 쓰더라도 같은 유일 제약 덕분에 충돌하지 않는다. 배치에서는 `createMany`의 `skipDuplicates`를 쓸 수 있다(MySQL 지원).

## 진행도 갱신은 이력과 함께

세션이 끝나면 이력 INSERT, 진행도 UPDATE, 과제 완료 처리가 한 번에 일어나야 한다. 하나만 반영되면 "이력은 있는데 레벨은 안 올랐다" 같은 상태가 생긴다. 셋을 하나의 트랜잭션으로 묶는다. 트랜잭션 방식의 선택과 동시성 처리는 [Prisma 트랜잭션](/2023/05/30/prisma-transactions/)에서 다뤘다.

```typescript
await this.prisma.$transaction([
  this.prisma.attempt.createMany({ data: attempts }),
  this.prisma.userProgress.update({
    where: { userId_typeCode: { userId, typeCode } },
    data: { points: { increment: gained }, level: nextLevel },
  }),
  this.prisma.dailyAssignment.update({
    where: { userId_date: { userId, date } },
    data: { status: 'COMPLETED', completedAt: new Date() },
  }),
]);
```

## 인덱스는 조회 패턴에서 나온다

| 조회 | 인덱스 | 비고 |
|---|---|---|
| 내 최근 풀이 목록 | `Attempt(userId, solvedAt)` | 기간 조건 + 정렬을 인덱스로 해결 |
| 유형별 기간 통계 | `Attempt(userId, typeCode, solvedAt)` | 등호 조건을 앞에, 범위 조건을 뒤에 |
| 세션 결과 화면 | `Attempt(sessionId)` | 한 세션의 문항들 |
| 오늘의 과제 | `DailyAssignment(userId, date)` 유일 | 유일 제약이 인덱스를 겸함 |
| 레벨에 맞는 세트 | `ItemSet(typeCode, level, active)` | 배정 시 후보 조회 |
| 현재 레벨 | `UserProgress(userId, typeCode)` 기본키 | 별도 인덱스 불필요 |

복합 인덱스에서 범위 조건(`solvedAt BETWEEN`) 뒤의 컬럼은 탐색 범위를 좁히는 데 쓰이지 않는다. 그래서 등호로 비교하는 `userId`, `typeCode`를 앞에 두고 `solvedAt`을 마지막에 둔다.

## 정규화 vs JSON 컬럼

문항 유형마다 필드가 다르면(보기 목록, 정답 순서, 녹음 분석 결과) JSON 컬럼이 편해 보인다. Prisma의 `Json` 타입은 MySQL `JSON` 컬럼에 매핑된다.

| 기준 | 정규화된 컬럼·테이블 | JSON 컬럼 |
|---|---|---|
| 스키마 변경 | 마이그레이션 필요 | 코드만 바꾸면 됨 |
| 타입 안정성 | Prisma 타입이 컬럼별로 생성 | `JsonValue`, 런타임 검증 필요 |
| 필터·집계 | 일반 인덱스, `groupBy` 가능 | 경로 필터는 가능하나 인덱스·집계가 불편 |
| 무결성 | 외래키·유일 제약 | 애플리케이션이 책임 |
| 적합한 데이터 | 조회·집계 대상(정답 여부, 응답 시간, 레벨) | 표시만 하는 부가 정보(보기 목록, 분석 원본) |

기준은 "이 값으로 WHERE·GROUP BY를 하는가"다. 정답 여부, 응답 시간, 유형, 레벨은 통계의 축이므로 컬럼으로 둔다. 보기 목록이나 음성 분석 원본처럼 화면에 다시 보여 주기만 하는 값은 `Json` 컬럼(`detail Json?`)에 넣어도 된다. 나중에 JSON 안의 값으로 집계해야 할 일이 생기면 그때 컬럼으로 승격한다.

## 정리

1. 콘텐츠, 진행도, 이력, 오늘의 과제는 쓰기 패턴이 다르므로 테이블을 나눈다.
2. 콘텐츠는 `(typeCode, level)` 자연키로 정규화하고, 수정은 새 세트를 활성화하는 방식으로 한다.
3. 진행도는 `(userId, typeCode)` 복합 기본키로 사용자·유형당 한 행을 강제한다.
4. 이력은 Append-only로 쌓고, 풀이 시점의 콘텐츠를 스냅샷으로 복사해 원본 변경과 분리한다.
5. 오늘의 과제는 `@@unique([userId, date])`로 멱등하게 만들고, `P2002`를 잡아 기존 행을 돌려준다.
6. 인덱스는 등호 조건 → 범위 조건 순으로 조회 패턴에 맞춰 만든다.
7. 필터·집계 대상은 컬럼으로, 표시용 부가 정보만 JSON 컬럼으로 둔다.
