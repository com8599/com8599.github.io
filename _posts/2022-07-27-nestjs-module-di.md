---
layout: post
title: NestJS 모듈 캡슐화와 의존성 주입
date: 2022-07-27
tags: [nestjs]
description: provider가 보이는 범위, 중복 인스턴스, 순환 참조, 주입 스코프.
---

NestJS는 모듈 단위로 의존성 주입(Dependency Injection, DI) 컨테이너를 구성한다. 모듈은 provider를 캡슐화(encapsulation)하므로, provider는 기본적으로 **선언한 모듈 안에서만** 주입할 수 있다.

## 에러 메시지 읽기

```text
Nest can't resolve dependencies of the OrdersService (?).
Please make sure that the argument UsersService at index [0]
is available in the OrdersModule context.
```

`OrdersModule`의 주입 범위 안에 `UsersService`가 없다는 뜻이다. 범위는 다음으로 구성된다.

1. `OrdersModule`의 `providers`
2. `imports`한 모듈들이 `exports`한 provider
3. `@Global()` 모듈이 `exports`한 provider

## 올바른 공유 방법

```ts
@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

@Module({
  imports: [UsersModule],
  providers: [OrdersService],
})
export class OrdersModule {}
```

## providers에 다시 등록하면 안 되는 이유

```ts
@Module({
  providers: [OrdersService, UsersService], // 잘못된 방법
})
export class OrdersModule {}
```

에러는 사라지지만 `OrdersModule` 전용 `UsersService` 인스턴스가 **하나 더** 생긴다. 내부 상태(캐시, 연결)를 가진 서비스라면 모듈마다 다른 상태를 보게 되고, 그 서비스가 의존하는 provider도 이 모듈에서 다시 해결해야 한다.

## 순환 참조

순환 참조(circular dependency)는 두 대상이 서로를 필요로 하는 상황이다. 두 모듈이 서로를 import하면 한쪽이 아직 정의되지 않은 시점에 참조되어 `undefined`가 된다. 모듈 간 순환은 **양쪽 모두** `forwardRef()`로 감싸고, provider 간 순환도 양쪽 생성자에서 `@Inject(forwardRef(() => ...))`를 쓴다.

```ts
@Module({ imports: [forwardRef(() => OrdersModule)] })
export class UsersModule {}

@Module({ imports: [forwardRef(() => UsersModule)] })
export class OrdersModule {}

@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
  ) {}
}
```

`forwardRef`는 해결 시점을 늦출 뿐이고, 이때 어느 쪽 생성자가 먼저 호출될지는 정해져 있지 않다. 순환이 생기면 공통 로직을 제3의 모듈로 분리하거나, 이벤트로 의존 방향을 끊는 것을 먼저 검토한다.

## 주입 스코프(injection scope)

| 스코프 | 인스턴스 수명 |
|---|---|
| `DEFAULT` | 애플리케이션 전체 싱글턴(singleton) |
| `REQUEST` | 요청마다 새 인스턴스 |
| `TRANSIENT` | 주입받는 곳마다 새 인스턴스 |

`REQUEST` 스코프는 **의존 체인을 따라 전파된다**. request 스코프 provider를 주입받는 서비스와 컨트롤러도 요청마다 다시 생성되므로 성능에 영향이 있다. `TRANSIENT`는 이렇게 전파되지 않는다.

## 커스텀 provider

```ts
@Module({
  providers: [
    { provide: 'CONFIG', useValue: { ttl: 60 } },
    { provide: CacheStore, useClass: process.env.REDIS ? RedisStore : MemoryStore },
    {
      provide: 'DB',
      useFactory: async (config: ConfigService) => createPool(config.get('DB_URL')),
      inject: [ConfigService],
    },
  ],
})
export class InfraModule {}
```

클래스가 아닌 토큰은 `@Inject('CONFIG')`로 주입받는다.
