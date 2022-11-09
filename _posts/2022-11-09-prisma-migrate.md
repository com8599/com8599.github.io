---
layout: post
title: Prisma Migrate — dev, deploy, db push, 그리고 drift
date: 2022-11-09
tags: [nestjs]
description: 각 명령이 하는 일과 운영 DB에서 쓰면 안 되는 명령, 기존 DB에 마이그레이션을 도입하는 baseline.
---

Prisma Migrate는 `prisma/migrations` 폴더의 SQL 파일과 DB의 `_prisma_migrations` 테이블로 이력을 관리한다. 명령마다 이 이력을 다루는 방식이 다르고, 일부는 데이터를 지운다.

## 명령 비교

| 명령 | 용도 | 마이그레이션 파일 | 섀도 DB(shadow database) | 리셋 가능성 |
|---|---|---|---|---|
| `migrate dev` | 개발 중 스키마 변경 | 생성 + 적용 | 사용 | 있음 |
| `migrate deploy` | 운영·스테이징 적용 | 적용만 | 사용 안 함 | 없음 |
| `migrate reset` | 개발 DB 초기화 | 전체 재적용 후 시드 실행 | 사용 | 항상 |
| `db push` | 프로토타이핑 | 남기지 않음 | 사용 안 함 | `--force-reset` 지정 시 |

`db push`는 데이터 손실이 생기는 변경이면 오류를 내고 멈추며, `--accept-data-loss`를 붙여야 적용한다. 리셋 자체는 `--force-reset`을 줄 때만 한다.

## migrate dev의 동작

1. **섀도 DB**를 만들고 기존 마이그레이션 이력을 다시 적용한다.
2. 그 결과와 개발 DB를 비교해 **드리프트(drift)**, 즉 이력에 없는 변경을 찾고, 적용된 마이그레이션 파일이 수정·삭제됐는지(이력 충돌)도 확인한다.
3. drift나 이력 충돌이 있으면 DB 리셋을 제안한다.
4. `schema.prisma`와 차이를 계산해 새 마이그레이션 파일을 만들고, 적용되지 않은 마이그레이션을 개발 DB에 적용한다.
5. `prisma generate`를 실행한다.

3번 때문에 `migrate dev`는 운영 DB에 절대 연결하면 안 된다.

## drift와 이력 충돌이 생기는 경로

- `db push`로 스키마를 반영한 뒤 Migrate로 전환했다. (drift)
- DB에 직접 DDL을 실행했다. (drift)
- 이미 적용된 마이그레이션 SQL을 수정하거나 삭제했다. (이력 충돌)

## 기존 DB에 마이그레이션 도입하기 (baseline)

이미 테이블이 있는 DB에 이력을 만들 때는 현재 스키마를 첫 마이그레이션으로 만들고, 적용된 것으로 표시한다. 이 작업을 베이스라인(baselining)이라고 한다.

```bash
mkdir -p prisma/migrations/0_init
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql

npx prisma migrate resolve --applied 0_init
```

생성된 `migration.sql`은 실제 스키마와 맞는지 검토한 뒤 표시한다. `migrate resolve`는 SQL을 실행하지 않고 `_prisma_migrations`에 기록만 남긴다. 실패한 마이그레이션을 롤백된 것으로 표시해 다시 적용할 수 있게 할 때는 `--rolled-back`을 쓴다.

## 섀도 DB 권한

`migrate dev`는 섀도 DB를 자동으로 만들고 지우기 위해 `CREATE DATABASE` 권한이 필요하다. 클라우드 관리형 DB처럼 권한이 없으면 섀도 DB를 직접 만들어 `shadowDatabaseUrl`로 지정한다.

```prisma
datasource db {
  provider          = "mysql"
  url               = env("DATABASE_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
}
```

## 운영 원칙

1. 로컬 `.env`의 `DATABASE_URL`은 로컬 DB만 가리킨다. 운영 접속 정보는 배포 환경 변수로만 주입한다.
2. 운영 적용은 CI/CD에서 `prisma migrate deploy`로만 한다.
3. 적용된 마이그레이션 파일은 수정하지 않는다. 고칠 내용은 새 마이그레이션으로 만든다.
4. 컬럼 삭제·이름 변경처럼 데이터 손실이 있는 변경은 생성된 SQL을 검토하고 필요하면 직접 수정한다(`migrate dev --create-only`).
