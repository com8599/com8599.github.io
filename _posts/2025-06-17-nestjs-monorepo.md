---
layout: post
title: 여러 NestJS 서비스를 한 저장소로 — Nest CLI 모노레포 모드와 공유 라이브러리
date: 2025-06-17
tags: [nestjs]
description: Nest CLI의 모노레포 모드가 프로젝트를 구성하고 빌드하는 방식, 공유 라이브러리와 경로 별칭, 앱별 Docker 빌드, 그리고 Nx·Turborepo·pnpm 워크스페이스와의 차이.
---

NestJS 서비스가 여러 개로 늘어나면 저장소도 서비스마다 하나씩 생기기 쉽다. 그러면 같은 DTO, 설정 로딩 코드, 인증 가드가 저장소마다 복사되고, 한쪽에서 고친 버그가 다른 쪽에는 남는다. 공통 코드를 npm 패키지로 빼면 복사는 없어지지만, 이번에는 "패키지 수정 → 버전 올림 → 배포 → 각 서비스에서 버전 갱신"이라는 왕복이 생긴다.

모노레포(Monorepo)는 여러 프로젝트를 한 저장소에 두고 공통 코드를 소스 수준에서 공유하는 구성이다. Nest CLI는 별도 도구 없이 이 구성을 지원하는 **모노레포 모드**를 제공한다. 이 글은 NestJS 11과 Nest CLI 11 기준으로 정리한다.

## 표준 모드와 모노레포 모드

`nest new`로 만든 프로젝트는 표준 모드(Standard mode)다. 프로젝트 하나가 저장소 하나를 차지하고, `src/`와 `package.json`, `tsconfig.json`이 루트에 있다. 여기에 두 번째 앱을 추가하면 Nest CLI가 구조를 모노레포 모드로 바꾼다.

```bash
nest new platform
cd platform
nest generate app billing
```

실행 후 구조는 다음과 같다.

```text
platform/
├── apps/
│   ├── platform/          # 원래 앱 (기본 프로젝트가 됨)
│   │   ├── src/
│   │   └── tsconfig.app.json
│   └── billing/
│       ├── src/
│       └── tsconfig.app.json
├── nest-cli.json
├── package.json
└── tsconfig.json
```

원래 앱은 `apps/` 아래로 옮겨지고 **기본 프로젝트(Default project)** 가 된다. 각 앱은 루트 `tsconfig.json`을 확장하는 `tsconfig.app.json`만 가지며, `package.json`은 루트에 하나뿐이다. 모든 앱이 같은 `node_modules`와 같은 의존성 버전을 쓴다. 이 변환은 Nest의 기본 구조를 따르는 프로젝트에서만 제대로 동작한다.

| 항목 | 표준 모드 | 모노레포 모드 |
|---|---|---|
| 프로젝트 수 | 1개 | 여러 앱 + 라이브러리 |
| `package.json` | 프로젝트별 | 루트에 하나(공유) |
| 기본 컴파일러 | `tsc` | webpack |
| 빌드 결과 | 파일별 `.js` | 앱별 단일 번들 파일 |
| 공통 코드 공유 | npm 패키지 | `libs/` 라이브러리 + 경로 별칭 |
| `nest-cli.json`의 `projects` | 없음 | 앱·라이브러리 목록 |

## nest-cli.json

모노레포로 바뀐 뒤 `nest-cli.json`은 다음과 같은 모양이 된다.

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "apps/platform/src",
  "monorepo": true,
  "root": "apps/platform",
  "compilerOptions": {
    "webpack": true,
    "tsConfigPath": "apps/platform/tsconfig.app.json"
  },
  "projects": {
    "platform": {
      "type": "application",
      "root": "apps/platform",
      "entryFile": "main",
      "sourceRoot": "apps/platform/src",
      "compilerOptions": { "tsConfigPath": "apps/platform/tsconfig.app.json" }
    },
    "billing": {
      "type": "application",
      "root": "apps/billing",
      "entryFile": "main",
      "sourceRoot": "apps/billing/src",
      "compilerOptions": { "tsConfigPath": "apps/billing/tsconfig.app.json" }
    }
  }
}
```

| 속성 | 의미 |
|---|---|
| `monorepo` | 모노레포 모드 여부 |
| `root` | 기본 프로젝트의 루트. 프로젝트 이름 없이 `nest build`/`nest start`를 실행하면 이 프로젝트가 대상 |
| `compilerOptions.webpack` | webpack 사용 여부. 모노레포 모드의 기본값은 `true`, 표준 모드는 `false`. 문서상 `builder`로 대체 권장 |
| `compilerOptions.builder` | `tsc`, `swc`, `webpack` 중 선택 |
| `projects.*.type` | `application` 또는 `library` |
| `projects.*.entryFile` | 앱은 `main`, 라이브러리는 `index` |

주의할 점은 **프로젝트 수준 `compilerOptions`가 최상위 설정과 병합되지 않고 덮어쓴다**는 것이다. 예를 들어 프로젝트에 `assets`를 지정하면 최상위 `assets` 배열은 그 프로젝트에 적용되지 않는다.

## 왜 webpack이 기본인가

공식 문서는 모노레포에서 webpack을 기본으로 쓰는 이유로 빌드 시간과 **모든 구성 요소를 하나의 파일로 묶는 번들**을 든다. 라이브러리 코드가 앱 번들 안에 포함되므로, 실행 시점에 경로 별칭을 해석할 필요가 없다. 개별 파일 출력이 필요하면 `webpack`을 `false`로 두거나 `builder`를 `tsc` 또는 `swc`로 바꾼다.

기본 webpack 설정은 `node_modules`를 번들에서 **제외**한다(externals). 즉 번들은 작아지지만 실행할 때는 `node_modules`가 옆에 있어야 한다. Docker 이미지를 만들 때 이 점이 중요하다.

`tsc`로 바꿀 경우 경로 별칭이 문제가 된다. TypeScript 컴파일러는 `paths` 별칭을 출력 코드에서 상대 경로로 바꾸지 않는다. Nest CLI는 빌드 과정에 경로 별칭을 처리하는 훅(hook)을 두고 있으므로 `nest build`를 쓰면 되지만, `tsc`를 직접 실행하는 스크립트를 따로 만들면 실행 시 모듈을 찾지 못한다.

## 앱별 빌드와 실행

```bash
nest start billing --watch     # billing 앱 개발 실행
nest build billing             # dist/apps/billing/main.js 생성
nest build                     # 기본 프로젝트(platform) 빌드
node dist/apps/billing/main.js
```

앱별 `tsconfig.app.json`의 `outDir`이 `../../dist/apps/<앱 이름>`으로 생성되므로 결과물이 앱별 디렉터리로 나뉜다. `package.json` 스크립트는 기본 프로젝트 기준으로 만들어져 있으므로 앱별 스크립트를 추가해 두면 CI에서 쓰기 편하다.

```json
{
  "scripts": {
    "build:platform": "nest build platform",
    "build:billing": "nest build billing",
    "start:billing:dev": "nest start billing --watch"
  }
}
```

## 공유 라이브러리

라이브러리는 단독으로 실행되지 않고 앱에 import되어야 실행되는 프로젝트다. `main.ts`가 없다.

```bash
nest g library contracts
# What prefix would you like to use for the library (default: @app)?
```

`libs/contracts/src/` 아래에 `index.ts`, 모듈, 서비스와 `tsconfig.lib.json`이 생기고, 루트 `tsconfig.json`의 `paths`에 별칭이 추가된다.

```json
{
  "compilerOptions": {
    "paths": {
      "@app/contracts": ["libs/contracts/src"],
      "@app/contracts/*": ["libs/contracts/src/*"]
    }
  }
}
```

앱에서는 다른 Nest 모듈과 똑같이 import한다.

```typescript
import { Module } from '@nestjs/common';
import { ContractsModule } from '@app/contracts';
import { CreateInvoiceDto } from '@app/contracts/billing/create-invoice.dto';

@Module({
  imports: [ContractsModule],
})
export class BillingModule {}
```

모듈 간 provider 공유 규칙은 앱 안의 모듈과 같다. 내보내지 않은 provider는 보이지 않는다는 점은 [NestJS 모듈 캡슐화와 의존성 주입](/2022/07/27/nestjs-module-di/)에서 다뤘다.

### 무엇을 라이브러리로 뺄 것인가

| 후보 | 예 | 주의 |
|---|---|---|
| 계약(DTO, 이벤트 타입) | 서비스 간 요청·응답 DTO, 메시지 페이로드 | 변경하면 모든 소비자가 함께 바뀜. 하위 호환을 지킨다 |
| 설정 | 환경 변수 스키마, `ConfigModule` 구성 | 앱별 값은 앱에 두고 로딩 규칙만 공유 |
| 인증 | JWT 검증 가드, 현재 사용자 데코레이터 | 정책이 앱마다 다르면 옵션으로 받는 동적 모듈로 |
| 공통 인프라 | 로거 설정, 예외 필터, 헬스 체크 | 비즈니스 로직은 넣지 않는다 |

라이브러리에 **도메인 로직**을 넣기 시작하면 여러 앱이 같은 로직에 묶여 결국 따로 배포할 수 없게 된다. 라이브러리는 계약과 횡단 관심사(Cross-cutting concern)에 한정하는 편이 안전하다.

### 테스트에서의 별칭

`paths`는 TypeScript 컴파일러만 이해한다. Jest는 모듈을 따로 해석하므로 별칭을 `moduleNameMapper`로 알려 줘야 한다. 라이브러리 생성 시 `package.json`의 Jest 설정에는 매핑이 추가되지만, e2e 테스트용 설정 파일(`test/jest-e2e.json` 등)을 따로 쓰고 있다면 같은 매핑을 직접 넣는다.

```json
{
  "moduleNameMapper": {
    "^@app/contracts(|/.*)$": "<rootDir>/../libs/contracts/src/$1"
  }
}
```

## 앱별 Docker 이미지

한 저장소에서 앱마다 이미지를 따로 만들려면 빌드 인자로 앱 이름을 받는다. 멀티 스테이지와 레이어 캐시 원리는 [Docker 멀티 스테이지 빌드로 Node 이미지 줄이기](/2023/09/12/docker-multi-stage-node/)에서 다뤘으므로 여기서는 모노레포에 특화된 부분만 본다.

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY nest-cli.json tsconfig*.json ./
COPY apps ./apps
COPY libs ./libs
ARG APP
RUN npx nest build ${APP}

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps  --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/dist/apps/${APP} ./dist
USER node
CMD ["node", "dist/main.js"]
```

```bash
docker build --build-arg APP=billing -t billing:1.4.0 .
docker build --build-arg APP=platform -t platform:2.1.0 .
```

모노레포 모드의 한계가 여기서 드러난다. `package.json`이 하나이므로 `npm ci --omit=dev`는 **모든 앱의 운영 의존성**을 설치한다. billing 앱이 쓰지 않는 패키지도 billing 이미지에 들어간다. 앱별 의존성을 분리하려면 webpack 설정에서 `node_modules`까지 번들하거나(네이티브 모듈은 예외 처리 필요), 앱마다 `package.json`을 두는 워크스페이스 방식으로 가야 한다.

또 하나는 변경 범위다. 라이브러리를 고치면 그 라이브러리를 쓰는 모든 앱을 다시 빌드·배포해야 하는데, Nest CLI에는 "이번 변경이 어떤 앱에 영향을 주는가"를 계산하는 기능이 없다. CI에서 경로 기반 조건(`apps/billing/**`, `libs/**` 변경 시 billing 빌드)으로 직접 나눈다.

## 다른 모노레포 도구와 비교

| 도구 | 성격 | 장점 | 비용 |
|---|---|---|---|
| Nest CLI 모노레포 모드 | Nest 전용 프로젝트 구성 | 추가 도구 없음, 설정이 거의 자동 | 단일 `package.json`, 영향 범위 계산·캐시 없음 |
| Nx | 모노레포 빌드 시스템 + 플러그인(`@nx/nest`) | 의존 그래프 기반 영향 범위(affected) 실행, 작업 캐시, 생성기 | 도구 학습과 설정 규모가 큼 |
| Turborepo | 패키지 매니저 워크스페이스 위의 작업 실행기 | 작업 결과 캐시(로컬·원격), 단순한 설정 | 프로젝트 생성·코드 생성은 직접 |
| pnpm 워크스페이스 | 패키지 매니저 수준의 다중 패키지 | 패키지별 `package.json`과 의존성, `workspace:` 프로토콜, `--filter` | 빌드 순서·캐시는 별도 도구 필요 |

서비스가 두세 개이고 모두 NestJS라면 Nest CLI 모노레포 모드로 충분하다. 서비스 수가 늘어 CI 시간이 문제가 되거나 프론트엔드 등 다른 종류의 프로젝트가 섞이면 Nx나 Turborepo + 워크스페이스로 옮기는 것을 검토한다. 이때 `apps/`와 `libs/` 구조와 `@app/*` 별칭은 그대로 가져갈 수 있다.

## 정리

1. 표준 모드 프로젝트에서 `nest generate app`을 실행하면 모노레포 모드로 바뀌고, 기존 앱은 `apps/` 아래의 기본 프로젝트가 된다.
2. 모노레포 모드는 `package.json`과 `node_modules`를 공유하며, 기본 컴파일러는 webpack이고 앱별 단일 번들을 `dist/apps/<앱>`에 만든다.
3. `nest g library`는 `libs/` 아래에 라이브러리를 만들고 `tsconfig.json`의 `paths`에 별칭을 추가한다. Jest e2e 설정의 매핑은 직접 맞춘다.
4. 라이브러리는 계약(DTO), 설정, 인증, 공통 인프라 같은 횡단 관심사에 한정하고 도메인 로직은 넣지 않는다.
5. 앱별 Docker 이미지는 빌드 인자로 앱을 고르되, 운영 의존성은 모든 앱의 합집합이 된다는 점을 감안한다.
6. 영향 범위 계산과 캐시가 필요해지면 Nx, Turborepo, pnpm 워크스페이스를 검토한다.
