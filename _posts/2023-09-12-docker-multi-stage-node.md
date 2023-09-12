---
layout: post
title: Docker 멀티 스테이지 빌드(Multi-stage Build)로 Node 이미지 줄이기
date: 2023-09-12
tags: [infra]
description: 빌드 도구와 런타임을 분리하고 레이어 캐시 순서를 맞춰 Node 이미지를 작고 빠르게 만드는 방법.
---

Node 애플리케이션을 가장 단순하게 컨테이너로 만들면 `node` 이미지에 소스를 통째로 복사하고 `npm install` 후 빌드하는 Dockerfile이 된다. 동작은 하지만 결과 이미지에는 TypeScript 컴파일러, 테스트 도구, 린터 같은 개발 의존성과 원본 소스, 빌드 캐시가 모두 남는다. 이미지가 커지면 푸시·풀 시간이 늘고, 실행에 필요 없는 패키지만큼 취약점 점검 대상도 늘어난다.

멀티 스테이지 빌드는 하나의 Dockerfile 안에서 빌드 환경과 실행 환경을 나누고, 실행에 필요한 결과물만 최종 이미지로 옮기는 기능이다.

## 단일 스테이지의 문제

```dockerfile
FROM node:18
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
CMD ["npm", "start"]
```

| 문제 | 원인 |
|---|---|
| 이미지가 큼 | 개발 의존성, 소스, 빌드 도구가 최종 이미지에 포함 |
| 빌드가 느림 | 소스 한 줄만 바꿔도 `npm install`부터 다시 실행 |
| 재현성이 낮음 | `npm install`은 lock 파일과 다른 버전을 설치할 수 있음 |
| 종료 신호 처리 | `npm start`가 PID 1이 되어 `SIGTERM`을 앱에 바로 전달하지 않음 |
| root로 실행 | 기본 사용자가 root |

## 멀티 스테이지의 구조

`FROM` 명령마다 새 스테이지가 시작된다. `FROM ... AS <이름>`으로 스테이지에 이름을 붙이고, 뒤쪽 스테이지에서 `COPY --from=<이름>`으로 앞 스테이지의 파일만 골라 가져온다. 최종 이미지는 마지막 스테이지(또는 `--target`으로 지정한 스테이지)만으로 구성되므로, 앞 스테이지에 설치한 도구는 결과에 남지 않는다.

```dockerfile
FROM node:18-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
```

스테이지 이름 대신 인덱스(`--from=0`)도 쓸 수 있지만, 명령 순서가 바뀌면 깨지므로 이름을 쓴다. `COPY --from`에는 외부 이미지 이름도 줄 수 있다(`COPY --from=nginx:latest ...`).

BuildKit은 최종 타깃이 의존하는 스테이지만 빌드하고, 쓰이지 않는 스테이지는 건너뛴다. Docker 23.0부터 Linux의 기본 빌더가 BuildKit이다. 테스트 전용 스테이지를 두고 CI에서만 `docker build --target test .`로 실행하는 구성도 이 성질 덕분에 가능하다.

## 레이어 캐시와 COPY 순서

Dockerfile의 각 명령은 레이어가 되고, 어떤 레이어가 바뀌면 그 뒤의 모든 레이어가 다시 빌드된다. `COPY`는 복사하는 파일 내용이 바뀌면 캐시가 무효화된다.

따라서 자주 바뀌는 것을 뒤로 보낸다. 의존성 목록(`package.json`, `package-lock.json`)은 소스보다 훨씬 드물게 바뀌므로 먼저 복사하고 설치한다.

| 순서 | 소스만 바뀐 경우 |
|---|---|
| `COPY . .` → `npm ci` | `npm ci`부터 전부 재실행 |
| `COPY package*.json` → `npm ci` → `COPY . .` | `npm ci` 레이어는 캐시 사용, 소스 복사부터 재실행 |

BuildKit의 캐시 마운트를 쓰면 의존성이 바뀌어 `npm ci`가 다시 실행될 때도 npm 캐시 디렉터리를 재사용할 수 있다. 캐시 마운트 내용은 이미지 레이어에 포함되지 않는다.

```dockerfile
RUN --mount=type=cache,target=/root/.npm npm ci
```

## npm ci와 --omit=dev

`npm ci`는 CI와 이미지 빌드를 위한 설치 명령이다.

- `package-lock.json`(또는 `npm-shrinkwrap.json`)이 반드시 있어야 한다.
- lock 파일과 `package.json`이 맞지 않으면 lock 파일을 고치지 않고 오류로 종료한다.
- 기존 `node_modules`가 있으면 지우고 새로 설치한다.
- `package.json`이나 lock 파일을 수정하지 않는다.

실행 이미지에는 운영 의존성만 필요하다. npm 7부터 `--omit=dev`가 도입되었고, npm 8 이후 문서에서 `--production`과 `--only=production`은 `--omit=dev`의 별칭이자 사용 중단(deprecated) 옵션으로 표시된다. 2023년 2월 이후 Node 18 릴리스에는 npm 9가 포함되어 있으므로 `--omit=dev`를 쓴다.

| 옵션 | 상태(npm 8/9) |
|---|---|
| `--omit=dev` | 권장 |
| `--production` | 사용 중단, `--omit=dev`의 별칭 |
| `--only=production` | 사용 중단, `--omit=dev`의 별칭 |

주의할 점은 `NODE_ENV`와의 관계다. `omit`의 기본값은 `NODE_ENV=production`일 때 `dev`다. 빌드 스테이지에서 `ENV NODE_ENV=production`을 먼저 선언하면 `npm ci`가 개발 의존성을 설치하지 않아 TypeScript 컴파일 같은 빌드 단계가 실패한다. `NODE_ENV`는 실행 스테이지에서만 설정한다.

## 전체 Dockerfile

TypeScript로 작성한 서버를 예로 든다. 운영 의존성 설치, 빌드, 실행을 세 스테이지로 나눈다.

```dockerfile
FROM node:18-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:18-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:18-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`deps`와 `build`는 서로 의존하지 않으므로 BuildKit이 병렬로 실행한다. 최종 스테이지에는 운영 의존성과 빌드 결과만 들어가고 TypeScript, 테스트 도구, 원본 소스는 남지 않는다.

### USER node

공식 Node 이미지에는 uid 1000의 `node` 사용자가 미리 만들어져 있다. 공식 이미지의 모범 사례 문서는 컨테이너를 root가 아닌 이 사용자로 실행하라고 권한다. `COPY --chown=node:node`로 파일 소유자를 함께 지정하면 런타임에 파일을 써야 하는 경우에도 권한 문제가 없다. `--chown`은 Linux 컨테이너 빌드에서만 지원된다.

### CMD는 node로 직접

`CMD ["npm", "start"]`로 실행하면 npm이 PID 1이 되고 node는 자식 프로세스가 된다. 공식 이미지 문서는 `CMD ["node", "index.js"]`처럼 node를 직접 실행해 `SIGTERM`, `SIGINT`를 앱이 직접 받게 하라고 권한다. 또 Node.js는 PID 1로 동작하도록 설계되지 않았으므로 `docker run --init`이나 Tini 같은 init 프로세스를 함께 쓰는 것을 권장한다.

## alpine과 slim

| 태그 | 기반 | 특징 |
|---|---|---|
| `node:18` | Debian 전체 + buildpack-deps | 가장 크지만 빌드 도구 포함, 네이티브 모듈 빌드가 쉬움 |
| `node:18-slim` | Debian 최소 패키지 | node 실행에 필요한 패키지만 포함 |
| `node:18-alpine` | Alpine Linux | slim보다 약 25% 작음, musl libc 사용 |

alpine은 크기가 가장 작지만 C 표준 라이브러리로 glibc 대신 musl을 쓴다. 공식 이미지 README는 glibc용으로 작성된 프로그램이 일반적으로 Alpine에서 동작하지 않는다고 경고한다. Node 코드 자체는 문제가 없지만 `bcrypt`, `sharp`, Prisma 엔진처럼 네이티브 바이너리를 쓰는 패키지는 musl용 빌드가 따로 필요하다. 또 `git`, `bash` 같은 도구도 기본으로 들어 있지 않다.

가장 중요한 규칙은 **의존성을 설치한 스테이지와 실행 스테이지의 기반 이미지를 맞추는 것**이다. `node:18`에서 `npm ci`를 하고 `node:18-alpine`으로 `node_modules`를 복사하면, glibc용으로 내려받거나 빌드한 네이티브 모듈이 musl 환경에서 로드되지 않는다. 빌드 스테이지는 큰 이미지를, 실행 스테이지는 작은 이미지를 쓰고 싶다면 최소한 libc 계열(Debian끼리, Alpine끼리)은 같게 둔다.

## Prisma를 쓸 때

Prisma Client는 `prisma generate` 시점에 생성 코드와 쿼리 엔진(query engine) 바이너리를 기본적으로 `node_modules/.prisma/client`에 만든다. 멀티 스테이지에서 이 점이 두 가지 문제를 만든다.

첫째, 생성 위치가 `node_modules` 안이다. 위 Dockerfile처럼 `deps` 스테이지에서 운영 의존성만 새로 설치하면 `build` 스테이지에서 생성한 클라이언트가 없다. `prisma` CLI는 보통 개발 의존성이라 `deps` 스테이지에서 바로 생성할 수도 없다. 생성 결과를 명시적으로 복사한다.

```dockerfile
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
```

둘째, 엔진 바이너리는 운영체제와 OpenSSL 버전에 맞춰 선택된다. `binaryTargets`의 기본값 `native`는 `prisma generate`를 실행한 환경을 뜻한다. 생성한 스테이지와 실행 스테이지의 기반 이미지가 다르면 실행 시 엔진을 찾지 못한다. 이미지를 맞추는 것이 우선이고, 불가피하다면 스키마에 실행 환경을 추가한다.

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}
```

| 실행 이미지 | binaryTarget |
|---|---|
| Debian 12(bookworm), OpenSSL 3.0.x | `debian-openssl-3.0.x` |
| Debian 11(bullseye), OpenSSL 1.1.x | `debian-openssl-1.1.x` |
| Alpine 3.17 이상, OpenSSL 3.0.x | `linux-musl-openssl-3.0.x` |
| Alpine 3.16 이하, OpenSSL 1.1.x | `linux-musl` |

`node:18-slim` 태그가 가리키는 Debian 버전은 시점에 따라 바뀐다. 2023년 6월 Debian 12가 나온 뒤로 기본 태그가 bookworm으로 넘어갔으므로, 재현성이 중요하면 `node:18-bookworm-slim`처럼 배포판까지 고정한다. 또 bookworm 기반 slim 이미지에는 OpenSSL 라이브러리가 들어 있지 않아, Prisma 엔진이 OpenSSL 버전을 감지하지 못하거나 로드에 실패할 수 있다. 이때는 실행 스테이지와 `prisma generate`를 실행하는 스테이지에 OpenSSL을 설치한다.

```dockerfile
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
```

## .dockerignore

`docker build`는 빌드 컨텍스트(build context)를 빌더로 보낸 뒤 Dockerfile을 실행한다. 컨텍스트 루트의 `.dockerignore`에 맞는 파일은 보내기 전에 제외된다.

```bash
cat > .dockerignore <<'EOF'
node_modules
dist
.git
.env*
npm-debug.log
Dockerfile
.dockerignore
EOF
```

| 항목 | 제외 이유 |
|---|---|
| `node_modules` | 로컬 OS용 네이티브 모듈이 이미지로 섞임, 컨텍스트가 커짐 |
| `dist` | 이미지 안에서 다시 빌드함 |
| `.git` | 크기가 크고 `COPY . .` 캐시를 불필요하게 깨뜨림 |
| `.env*` | 비밀 값이 이미지 레이어에 남음 |

특히 `node_modules`를 빠뜨리면 `COPY . .`가 `npm ci`로 설치한 디렉터리를 macOS에서 설치한 로컬 `node_modules`로 덮어쓸 수 있다. 패턴은 Go의 `filepath.Match` 규칙을 따르고, `**`로 임의 깊이의 디렉터리를, `!`로 예외를 지정한다. 마지막으로 일치한 줄이 적용되므로 순서가 중요하다.

## 크기가 줄어드는 지점

정확한 크기는 애플리케이션과 기반 이미지 버전마다 다르므로 직접 `docker image ls`로 비교해야 한다. 줄어드는 요인은 다음과 같다.

| 변경 | 줄어드는 것 |
|---|---|
| 멀티 스테이지 | 개발 의존성, 원본 소스, 빌드 도구 |
| `npm ci --omit=dev` | TypeScript, 테스트·린트 도구 등 devDependencies |
| `node:18` → `node:18-slim` | 컴파일러, 각종 Debian 패키지 |
| slim → alpine | 추가로 약 25%, 대신 musl 호환성 확인 필요 |
| `.dockerignore` | 컨텍스트 크기와 `COPY . .`로 섞이는 파일 |

## 정리

- `FROM ... AS`로 스테이지를 나누고 `COPY --from`으로 실행에 필요한 결과물만 최종 스테이지로 옮긴다.
- `package.json`과 lock 파일을 먼저 복사해 의존성 설치 레이어를 캐시하고, 소스 복사는 그 뒤에 둔다.
- 설치는 `npm ci`를, 운영 의존성만 필요하면 `--omit=dev`를 쓴다. `NODE_ENV=production`은 실행 스테이지에서만 설정한다.
- 실행은 `USER node`와 `CMD ["node", ...]`로 하고, 필요하면 `--init`을 함께 쓴다.
- alpine은 musl을 쓰므로 네이티브 모듈과 Prisma 엔진을 확인해야 하며, 설치 스테이지와 실행 스테이지의 기반 이미지를 맞추는 것이 기본 원칙이다.
- `.dockerignore`로 `node_modules`, `.git`, `.env`를 컨텍스트에서 제외한다.
