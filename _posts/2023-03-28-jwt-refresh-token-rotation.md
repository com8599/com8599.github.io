---
layout: post
title: JWT 액세스·리프레시 토큰과 토큰 회전(Refresh Token Rotation)
date: 2023-03-28
tags: [nestjs]
description: JWT의 구조와 클레임, 액세스·리프레시 토큰을 나누는 이유, 저장 위치의 trade-off, 리프레시 토큰 회전과 재사용 탐지를 NestJS로 구현하는 방법.
---

JWT(JSON Web Token)는 서버가 서명한 토큰을 클라이언트가 들고 다니는 방식이라 서버에 세션을 저장하지 않아도 된다. 대신 한 번 발급한 토큰은 만료 전까지 서버가 되돌리기 어렵다. 액세스 토큰과 리프레시 토큰을 나누고 리프레시 토큰을 회전시키는 구성은 이 약점을 줄이기 위한 것이다.

## JWT의 구조

JWT는 RFC 7519에 정의되어 있고, JWS(JSON Web Signature) 또는 JWE(JSON Web Encryption)의 컴팩트 직렬화(compact serialization)로 표현된다. 일반적으로 쓰는 서명 JWT는 점(`.`)으로 구분된 세 부분으로 이루어지며, 각 부분은 base64url로 인코딩된다.

| 부분 | 내용 | 예 |
|---|---|---|
| 헤더(header) | 서명 알고리즘, 토큰 타입 | `{"alg":"HS256","typ":"JWT"}` |
| 페이로드(payload) | 클레임(claim) 집합 | `{"sub":"42","exp":1680000000}` |
| 서명(signature) | 헤더와 페이로드에 대한 서명 | 바이너리 값의 base64url |

페이로드는 **암호화가 아니라 인코딩**이다. 누구나 디코딩해 읽을 수 있으므로 비밀번호나 개인정보를 넣으면 안 된다. 서명은 내용이 바뀌지 않았다는 것만 보장한다.

RFC 7519가 등록해 둔 클레임(registered claim)은 다음과 같다. 모두 선택 사항이며, 무엇을 필수로 볼지는 애플리케이션이 정한다.

| 클레임 | 의미 |
|---|---|
| `iss` | 발급자(issuer) |
| `sub` | 토큰의 주체(subject), 보통 사용자 ID |
| `aud` | 토큰을 받을 대상(audience) |
| `exp` | 만료 시각. 이 시각 이후에는 받아들이면 안 된다. |
| `nbf` | 이 시각 이전에는 받아들이면 안 된다(not before). |
| `iat` | 발급 시각(issued at) |
| `jti` | 토큰의 고유 ID(JWT ID) |

시각 값은 NumericDate, 즉 1970-01-01T00:00:00Z부터 지난 **초** 단위 숫자다. 밀리초인 `Date.now()`를 그대로 넣으면 아주 먼 미래가 되므로 주의한다.

## 액세스 토큰과 리프레시 토큰

| 항목 | 액세스 토큰(access token) | 리프레시 토큰(refresh token) |
|---|---|---|
| 용도 | API 호출 시 인증 | 새 액세스 토큰 발급 |
| 수명 | 짧게(수 분~수십 분) | 길게(수 일~수 주) |
| 전송 대상 | 모든 API | 토큰 갱신 엔드포인트 하나 |
| 서버 검증 | 서명과 `exp`만 확인(상태 없음) | DB 조회로 유효성 확인(상태 있음) |
| 탈취 시 피해 | 만료까지 | 회전·폐기로 제한 |

액세스 토큰은 매 요청마다 DB를 조회하지 않고 서명만 검증하므로 빠르지만, 탈취되면 만료 전까지 막을 방법이 마땅치 않다. 그래서 수명을 짧게 둔다. 그렇다고 사용자가 15분마다 다시 로그인할 수는 없으므로, 수명이 긴 리프레시 토큰으로 액세스 토큰을 다시 받는다. 리프레시 토큰은 갱신 엔드포인트에서만 쓰이고 그때마다 서버가 DB를 확인하므로, 서버 쪽에서 폐기(revocation)할 수 있다.

## 토큰을 어디에 저장할까

| 저장 위치 | XSS(cross-site scripting) | CSRF(cross-site request forgery) | 비고 |
|---|---|---|---|
| `localStorage` | 스크립트가 읽을 수 있어 탈취 가능 | 자동 전송되지 않아 영향 없음 | 구현이 단순 |
| 메모리(JS 변수) | 실행 중인 스크립트는 읽을 수 있음 | 영향 없음 | 새로고침하면 사라짐 |
| `HttpOnly` 쿠키 | 스크립트가 읽을 수 없음 | 자동 전송되므로 대비 필요 | `SameSite`로 완화 |

OWASP HTML5 Security Cheat Sheet는 세션 식별자를 `localStorage`에 두지 말라고 권한다. 그 데이터는 언제나 JavaScript로 접근할 수 있어, XSS 하나로 저장된 값이 모두 유출될 수 있기 때문이다. 쿠키는 `HttpOnly` 속성으로 이 위험을 줄일 수 있다.

쿠키에 넣을 때는 속성을 함께 지정한다.

| 속성 | 의미 |
|---|---|
| `HttpOnly` | `document.cookie`로 읽을 수 없다. 단, 요청에는 그대로 실려 간다. |
| `Secure` | HTTPS 요청에만 전송된다. |
| `SameSite=Strict` | 같은 사이트에서 시작된 요청에만 전송된다. |
| `SameSite=Lax` | 같은 사이트 요청과, 최상위 이동(top-level navigation) 중 안전한 메서드(GET 등) 요청에 전송된다. |
| `SameSite=None` | 교차 사이트 요청에도 전송된다. 반드시 `Secure`가 필요하다. |
| `Path` | 이 경로를 포함한 URL로 가는 요청에만 전송된다. |
| `Max-Age` | 만료까지 남은 초. `Expires`와 함께 있으면 `Max-Age`가 우선한다. |

`HttpOnly`는 XSS로 토큰 **값을 훔치는 것**을 막을 뿐, XSS가 있는 페이지에서 사용자 대신 요청을 보내는 것까지 막지는 못한다. 반대로 쿠키는 브라우저가 자동으로 붙이므로 CSRF를 고려해야 한다. `SameSite=Strict` 또는 `Lax`, 그리고 상태를 바꾸는 요청에 대한 CSRF 토큰이나 `Origin` 검사로 대응한다.

자주 쓰는 구성은 다음과 같다.

- 액세스 토큰은 응답 본문으로 받아 메모리에 두고 `Authorization: Bearer` 헤더로 보낸다.
- 리프레시 토큰은 `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh` 쿠키에 둔다. `Path`를 좁히면 갱신 요청 외에는 쿠키가 실려 가지 않는다.

## 리프레시 토큰 회전

리프레시 토큰 회전(refresh token rotation)은 리프레시 토큰을 **한 번만 쓸 수 있게** 만드는 방식이다. 갱신 요청이 오면 새 액세스 토큰과 함께 새 리프레시 토큰을 발급하고, 방금 사용된 리프레시 토큰은 무효로 만든다.

IETF OAuth 작업 그룹의 OAuth 2.0 Security Best Current Practice 초안은 공개 클라이언트(public client)의 리프레시 토큰은 발신자 제한(sender-constrained)을 걸거나 회전을 사용해야 한다고 권고한다. 회전에서 핵심은 **재사용 탐지(reuse detection)**다.

1. 정상 사용자와 공격자가 같은 리프레시 토큰 R1을 가지고 있다.
2. 둘 중 하나가 먼저 R1을 사용해 R2를 받는다. R1은 무효가 된다.
3. 나머지 하나가 무효가 된 R1을 제출한다.
4. 서버는 이미 사용된 토큰이 다시 들어왔다는 사실로 탈취를 알아챈다. 누가 공격자인지는 알 수 없으므로 이 계열(family)의 **활성 리프레시 토큰을 모두 폐기**한다.
5. 정상 사용자는 다시 로그인해야 하지만, 공격자가 가진 토큰도 함께 죽는다.

이를 위해 서버는 무효화한 토큰을 바로 지우지 않고 "같은 로그인에서 이어진 토큰"이라는 관계를 남겨 둔다. 보통 로그인할 때 `familyId`를 만들고, 회전으로 발급되는 토큰이 이 값을 물려받게 한다. 같은 초안은 일정 기간 사용되지 않은 리프레시 토큰도 만료시키라고 권한다.

## 리프레시 토큰은 해시로 저장한다

DB가 유출되었을 때 저장된 리프레시 토큰을 그대로 쓸 수 없도록 해시(hash)만 저장한다. 이때 bcrypt는 적합하지 않다. bcrypt는 입력의 **앞 72바이트만 사용**하는데, JWT는 이보다 길고 앞부분은 헤더처럼 모든 토큰이 공유하는 값이라 서로 다른 토큰이 같은 해시로 검증될 수 있다. 리프레시 토큰은 사람이 고른 비밀번호가 아니라 엔트로피(entropy)가 충분한 무작위 값이므로, 느린 해시 대신 SHA-256으로 충분하다.

```ts
import { createHash } from 'crypto';

export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
```

## 저장 모델

```ts
// refresh_tokens 테이블
interface RefreshTokenRecord {
  id: string;          // jti
  userId: string;
  familyId: string;    // 로그인 한 번에 하나
  tokenHash: string;   // sha256(토큰)
  expiresAt: Date;
  usedAt: Date | null; // 회전되어 사용된 시각
  revokedAt: Date | null;
}
```

| 상황 | `usedAt` | `revokedAt` | 처리 |
|---|---|---|---|
| 정상 토큰 | `null` | `null` | 회전 후 새 토큰 발급 |
| 이미 사용된 토큰 | 값 있음 | - | 재사용 탐지, 계열 전체 폐기 |
| 로그아웃·강제 폐기 | - | 값 있음 | 401 |
| 만료 | - | - | 401 |

## NestJS 구현

필요한 패키지는 다음과 같다.

```bash
npm i @nestjs/jwt @nestjs/passport passport passport-jwt cookie-parser
npm i -D @types/passport-jwt @types/cookie-parser
```

### 액세스 토큰 전략

`PassportStrategy(Strategy)`를 상속한 클래스의 `validate()`가 반환한 값은 `req.user`에 들어간다. 두 번째 인자로 전략 이름을 주면 `AuthGuard('이름')`으로 골라 쓸 수 있다.

```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class AccessTokenStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: { sub: string }) {
    return { userId: payload.sub };
  }
}
```

### 리프레시 토큰 전략

리프레시 토큰은 쿠키에서 꺼내고, 회전에 원본 토큰이 필요하므로 `passReqToCallback: true`로 요청 객체를 함께 받는다. 액세스 토큰과 **다른 시크릿**을 써야 액세스 토큰을 리프레시 토큰으로 제출하는 혼동을 막을 수 있다.

```ts
@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.refresh_token ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_REFRESH_SECRET'),
      passReqToCallback: true,
    });
  }

  validate(req: Request, payload: { sub: string; jti: string; fid: string }) {
    return {
      userId: payload.sub,
      jti: payload.jti,
      familyId: payload.fid,
      token: req.cookies.refresh_token,
    };
  }
}
```

`req.cookies`를 쓰려면 `main.ts`에서 `app.use(cookieParser())`를 등록한다.

### 발급과 회전

```ts
@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tokens: RefreshTokenRepository,
  ) {}

  async issue(userId: string, familyId = randomUUID()) {
    const jti = randomUUID();

    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { secret: this.config.get('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, fid: familyId },
      { secret: this.config.get('JWT_REFRESH_SECRET'), expiresIn: '14d', jwtid: jti },
    );

    await this.tokens.create({
      id: jti,
      userId,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    return { accessToken, refreshToken };
  }

  async rotate(user: { userId: string; jti: string; familyId: string; token: string }) {
    const record = await this.tokens.findById(user.jti);

    if (!record || record.tokenHash !== sha256(user.token) || record.revokedAt) {
      throw new UnauthorizedException();
    }

    if (record.usedAt) {
      await this.tokens.revokeFamily(record.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    const marked = await this.tokens.markUsedIfUnused(record.id);
    if (!marked) {
      await this.tokens.revokeFamily(record.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    return this.issue(user.userId, record.familyId);
  }
}
```

`markUsedIfUnused`는 `UPDATE ... SET used_at = now() WHERE id = ? AND used_at IS NULL`처럼 조건부 갱신으로 구현하고, 영향받은 행 수로 성공 여부를 판단한다. 조회 후 갱신을 따로 하면 같은 토큰으로 동시에 들어온 두 요청이 모두 통과할 수 있다.

### 컨트롤러

```ts
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @UseGuards(AuthGuard('jwt-refresh'))
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken } = await this.auth.rotate(req.user as RefreshUser);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/refresh',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    return { accessToken };
  }
}
```

Express의 `res.cookie()`에서 `maxAge`는 **밀리초** 단위이고, 헤더에는 초 단위 `Max-Age`로 변환되어 나간다. `@Res({ passthrough: true })`를 써야 응답 객체를 직접 다루면서도 반환값을 Nest가 직렬화해 준다.

## 폐기

| 상황 | 처리 |
|---|---|
| 로그아웃 | 현재 `familyId`의 토큰을 폐기하고 쿠키를 지운다. |
| 모든 기기에서 로그아웃 | 해당 `userId`의 토큰을 모두 폐기한다. |
| 비밀번호 변경 | 모든 토큰을 폐기한다. |
| 재사용 탐지 | 해당 `familyId`를 폐기한다. |

리프레시 토큰을 폐기해도 이미 발급된 액세스 토큰은 만료까지 유효하다. 즉시 차단이 필요하면 액세스 토큰의 `jti`나 사용자별 토큰 버전을 캐시에 두고 Guard에서 확인해야 하는데, 그만큼 상태를 갖게 된다. 대부분은 액세스 토큰 수명을 짧게 두는 것으로 이 공백을 허용한다.

## 정리

- JWT는 base64url로 인코딩된 헤더·페이로드·서명이며, 페이로드는 누구나 읽을 수 있다. `exp`, `iat` 등 시각 클레임은 초 단위다.
- 액세스 토큰은 짧게, 리프레시 토큰은 길게 두고, 리프레시 토큰만 서버 상태로 관리해 폐기할 수 있게 한다.
- `localStorage`는 XSS에 노출된다. 리프레시 토큰은 `HttpOnly; Secure; SameSite` 쿠키에 두고, 쿠키의 CSRF 위험은 `SameSite`와 좁은 `Path`로 줄인다.
- 리프레시 토큰을 회전시키고, 이미 사용된 토큰이 다시 오면 같은 계열을 모두 폐기한다.
- 리프레시 토큰은 SHA-256 해시로 저장한다. bcrypt는 앞 72바이트만 쓰므로 JWT에 맞지 않는다.
- NestJS에서는 전략 이름이 다른 두 passport-jwt 전략으로 액세스 토큰과 리프레시 토큰을 분리하고, 시크릿도 따로 둔다.
