---
layout: post
title: NestJS 요청 파이프라인 — Middleware, Guard, Interceptor, Pipe, Filter 실행 순서
date: 2023-01-31
tags: [nestjs]
description: 요청이 컨트롤러에 닿기까지 거치는 단계와 각 단계의 전역·컨트롤러·라우트 적용 순서, 그리고 전역 등록 방식의 차이.
---

NestJS에서 요청 하나는 컨트롤러 메서드에 닿기 전후로 여러 계층을 지난다. 계층마다 역할이 정해져 있고 실행 순서도 고정되어 있으므로, 인증을 Interceptor에서 하거나 검증을 Guard에서 하는 식으로 위치를 잘못 잡으면 의도와 다르게 동작한다.

## 전체 순서

공식 문서가 정리한 요청 생명주기(request lifecycle)는 다음과 같다.

1. 요청 수신
2. Middleware — 전역으로 바인딩된 것 먼저, 그다음 모듈에 바인딩된 것
3. Guard — 전역 → 컨트롤러 → 라우트
4. Interceptor(컨트롤러 실행 전) — 전역 → 컨트롤러 → 라우트
5. Pipe — 전역 → 컨트롤러 → 라우트 → 라우트 파라미터
6. 컨트롤러 메서드(핸들러)
7. 서비스(있다면)
8. Interceptor(컨트롤러 실행 후) — 라우트 → 컨트롤러 → 전역
9. Exception Filter — 라우트 → 컨트롤러 → 전역 (처리되지 않은 예외가 있을 때만)
10. 응답 전송

각 계층의 역할을 한 줄로 요약하면 다음과 같다.

| 계층 | 역할 | 접근 가능한 정보 | 결과 |
|---|---|---|---|
| Middleware | 요청 전처리(로깅, 헤더, 세션 등) | `req`, `res`, `next` | `next()` 호출 여부 |
| Guard | 이 요청을 처리할지 결정(인증·인가) | `ExecutionContext`(핸들러, 클래스, 메타데이터) | `true`/`false` 또는 예외 |
| Interceptor | 핸들러 실행 전후 로직, 응답 변환 | `ExecutionContext`, `CallHandler` | `Observable` |
| Pipe | 인자 변환(transformation)과 검증(validation) | 인자 값과 `ArgumentMetadata` | 변환된 값 또는 예외 |
| Exception Filter | 예외를 응답으로 바꾸기 | 예외 객체, `ArgumentsHost` | 응답 |

Middleware는 Express 미들웨어와 같은 수준에서 동작하므로 **어떤 핸들러가 실행될지 모른다**. 반면 Guard부터는 `ExecutionContext`로 대상 컨트롤러 클래스와 메서드, 그리고 `@SetMetadata()`로 붙인 메타데이터를 읽을 수 있다. 역할(role) 기반 인가처럼 "이 라우트에 어떤 권한이 필요한가"를 알아야 하는 로직이 Middleware가 아니라 Guard에 들어가는 이유다.

## Guard

Guard는 모든 Middleware 다음, 모든 Interceptor와 Pipe 이전에 실행된다. `canActivate()`가 `false`를 반환하면 Nest가 `ForbiddenException`을 던지고 클라이언트는 `403 Forbidden`을 받는다. 401처럼 다른 응답을 원하면 Guard 안에서 직접 `UnauthorizedException` 같은 예외를 던진다.

```ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get<string[]>('roles', context.getHandler());
    if (!roles) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    return roles.some((role) => user?.roles?.includes(role));
  }
}
```

같은 수준에 여러 Guard가 있으면 바인딩한 순서대로 실행되고, 하나라도 통과하지 못하면 이후 Guard와 핸들러는 실행되지 않는다.

```ts
@UseGuards(AuthGuard, RolesGuard) // AuthGuard → RolesGuard
@Controller('admin')
export class AdminController {}
```

## Interceptor

Interceptor는 핸들러 실행을 감싼다. `next.handle()`을 호출하기 전 코드는 핸들러 실행 전에, `next.handle()`이 반환하는 RxJS `Observable`에 연결한 연산자는 핸들러가 값을 낸 뒤에 실행된다. `next.handle()`을 호출하지 않으면 핸들러 자체가 실행되지 않으므로 캐시 같은 기능도 Interceptor로 구현한다.

```ts
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const { method, url } = context.switchToHttp().getRequest();

    return next.handle().pipe(
      tap(() => console.log(`${method} ${url} ${Date.now() - startedAt}ms`)),
    );
  }
}

@Injectable()
export class WrapInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => ({ data })));
  }
}
```

전처리는 전역 → 컨트롤러 → 라우트 순서지만 후처리는 **라우트 → 컨트롤러 → 전역** 순서다. 양파 껍질처럼 바깥 Interceptor가 안쪽 Interceptor 전체를 감싸기 때문이다. 전역 `LoggingInterceptor`와 라우트 `WrapInterceptor`를 함께 걸면 `WrapInterceptor`의 `map`이 먼저 적용되고, 그 결과를 `LoggingInterceptor`의 `tap`이 본다.

핸들러에서 던진 예외도 `Observable`의 에러로 흘러오므로 `catchError`로 잡아 다른 예외로 바꿀 수 있다. 이때 Interceptor가 처리하지 못한 예외만 Exception Filter로 넘어간다.

## Pipe

Pipe는 핸들러 인자를 변환하거나 검증한다. 순서는 전역 → 컨트롤러 → 라우트이고, 라우트 파라미터에 직접 붙인 Pipe(`@Param('id', ParseIntPipe)`)는 그다음에 실행된다. 공식 문서에 따르면 인자가 여러 개일 때는 **마지막 파라미터부터 첫 번째 파라미터 순서로** 처리된다.

```ts
@Get(':id')
findOne(
  @Param('id', ParseIntPipe) id: number,
  @Query('include') include?: string,
) {
  return this.ordersService.findOne(id, include);
}
```

가장 많이 쓰는 Pipe는 `ValidationPipe`다. `class-validator`와 `class-transformer` 패키지가 필요하다.

```bash
npm i class-validator class-transformer
```

```ts
export class CreateOrderDto {
  @IsInt()
  productId: number;

  @IsInt()
  @Min(1)
  quantity: number;
}

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
```

| 옵션 | 동작 |
|---|---|
| `whitelist` | 검증 데코레이터가 없는 속성을 결과 객체에서 제거한다. |
| `forbidNonWhitelisted` | 제거하는 대신 예외를 던진다. `whitelist`와 함께 쓴다. |
| `transform` | 일반 객체(plain object)를 DTO 클래스 인스턴스로 바꾸고, 문자열로 들어온 경로·쿼리 파라미터를 선언된 원시 타입(`number`, `boolean`)으로 변환한다. |

검증에 실패하면 기본적으로 `BadRequestException`(400)이 발생한다. `whitelist` 없이 DTO만 받으면 `isAdmin` 같은 선언하지 않은 필드가 그대로 서비스까지 전달될 수 있으므로, 대량 할당(mass assignment)을 막으려면 `whitelist`를 켜 두는 편이 안전하다.

## Exception Filter

Exception Filter는 다른 계층과 달리 **라우트 → 컨트롤러 → 전역** 순서로 찾는다. 가장 구체적인 필터부터 확인하고, 예외를 처리할 수 있는 필터를 찾으면 거기서 끝난다. 예외는 필터에서 필터로 전달되지 않으므로, 라우트 필터가 예외를 잡으면 전역 필터는 같은 예외를 보지 못한다.

```ts
@Catch(HttpException)
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();

    response.status(status).json({
      statusCode: status,
      message: exception.message,
      path: ctx.getRequest<Request>().url,
    });
  }
}
```

`@Catch()`에 인자를 주지 않으면 모든 예외를 잡는다. 어떤 필터도 처리하지 않은 예외는 Nest의 기본 전역 예외 필터가 받아, `HttpException`이 아니면 `500 Internal server error`로 응답한다.

## 적용 범위별 바인딩

| 범위 | Guard | Interceptor | Pipe | Filter |
|---|---|---|---|---|
| 라우트 | `@UseGuards()` | `@UseInterceptors()` | `@UsePipes()`, 파라미터 데코레이터 | `@UseFilters()` |
| 컨트롤러 | 클래스에 `@UseGuards()` | 클래스에 `@UseInterceptors()` | 클래스에 `@UsePipes()` | 클래스에 `@UseFilters()` |
| 전역 | `useGlobalGuards()` 또는 `APP_GUARD` | `useGlobalInterceptors()` 또는 `APP_INTERCEPTOR` | `useGlobalPipes()` 또는 `APP_PIPE` | `useGlobalFilters()` 또는 `APP_FILTER` |

데코레이터에 인스턴스 대신 클래스를 넘기면(`@UseGuards(RolesGuard)`) Nest가 인스턴스를 만들고 의존성을 주입한다.

## useGlobalX와 APP_X provider의 차이

전역으로 등록하는 방법은 두 가지다.

```ts
// main.ts
app.useGlobalGuards(new RolesGuard(new Reflector()));
```

```ts
// app.module.ts
import { APP_GUARD } from '@nestjs/core';

@Module({
  providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
})
export class AppModule {}
```

`useGlobalGuards()`는 모듈 바깥에서 등록하므로 **의존성 주입을 받을 수 없다**. 인스턴스를 직접 `new`로 만들어 넘겨야 하고, `ConfigService`나 리포지토리를 생성자에서 주입받는 Guard라면 이 방식으로는 쓸 수 없다. `APP_GUARD` 토큰으로 등록하면 Nest가 DI 컨테이너 안에서 인스턴스를 만들어 주므로 주입이 가능하다.

| 항목 | `app.useGlobalX()` | `APP_X` provider |
|---|---|---|
| 등록 위치 | `main.ts` | 아무 모듈의 `providers` |
| 의존성 주입 | 불가 | 가능 |
| 인스턴스 생성 | 직접 `new` | Nest DI 컨테이너 |
| 적용 범위 | 전역 | 전역(어느 모듈에 등록해도 전역) |

`APP_GUARD`는 어느 모듈에 선언하든 전역으로 적용된다. 그래서 보통 그 Guard가 정의된 모듈에 함께 선언해 두면 찾기 쉽다. 같은 토큰으로 여러 개를 등록할 수 있고, 등록한 순서대로 실행된다.

또 하나의 차이는 테스트다. `Test.createTestingModule()`로 만든 테스트 모듈은 `main.ts`를 거치지 않으므로 `useGlobalX()`로 등록한 것들이 빠진다. `APP_X`로 등록했다면 모듈을 불러오는 것만으로 함께 적용된다.

## Middleware에서 발생한 예외

Middleware는 라우트 핸들러가 정해지기 전에 실행되므로 컨트롤러나 라우트에 바인딩한 Exception Filter가 적용되지 않는다. Middleware에서 던진 예외는 전역 필터만 처리할 수 있다. 같은 이유로 Middleware에서는 Guard처럼 라우트 메타데이터를 읽을 수 없다.

## 정리

- 순서는 Middleware → Guard → Interceptor(전) → Pipe → 핸들러 → Interceptor(후) → Exception Filter다.
- Guard, Interceptor 전처리, Pipe는 전역 → 컨트롤러 → 라우트 순서로 실행된다.
- Interceptor 후처리와 Exception Filter는 반대로 라우트 → 컨트롤러 → 전역 순서이고, 필터는 처리할 수 있는 첫 필터에서 끝난다.
- 인증·인가는 메타데이터를 읽을 수 있는 Guard에, 입력 검증과 변환은 Pipe에, 응답 가공과 실행 시간 측정은 Interceptor에 둔다.
- `ValidationPipe`는 `whitelist`, `forbidNonWhitelisted`, `transform`을 함께 켜면 선언하지 않은 필드를 막고 타입 변환까지 처리한다.
- 의존성 주입이 필요한 전역 컴포넌트는 `useGlobalX()` 대신 `APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE`, `APP_FILTER` provider로 등록한다.
