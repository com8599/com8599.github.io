---
layout: post
title: 소셜 로그인 설계 — 카카오 앱 SDK 토큰을 서버에서 검증하고 자체 JWT 발급하기
date: 2025-12-02
tags: [nestjs]
description: 모바일 앱이 카카오 SDK로 받은 토큰을 서버가 직접 검증하는 두 가지 방법(액세스 토큰 조회, OIDC ID 토큰 서명 검증)을 비교하고, 계정 연결 모델과 자체 JWT 발급, 연결 해제 처리까지 정리한다.
---

모바일 앱에서 카카오 로그인을 붙이면 로그인 자체는 카카오 SDK가 처리한다. 사용자가 카카오톡이나 카카오계정으로 동의하면 앱은 카카오가 발급한 액세스 토큰(Access Token), 리프레시 토큰(Refresh Token), 그리고 OpenID Connect를 켠 경우 ID 토큰(ID Token)을 받는다. 남은 문제는 우리 서버가 "이 요청을 보낸 사람이 정말 카카오 회원 N번인가"를 어떻게 확인하느냐다.

## 클라이언트가 보낸 사용자 ID를 믿으면 안 되는 이유

가장 단순한 구현은 앱이 SDK로 회원번호를 조회해 `{ kakaoId: 123 }`을 서버로 보내고, 서버가 그 번호로 사용자를 찾아 토큰을 발급하는 것이다. 이 API는 누구나 호출할 수 있으므로, 다른 사람의 회원번호만 알면 그 사람으로 로그인된다. 회원번호는 비밀 값이 아니다. 로그에 남고, 화면 디버깅 중에 노출되고, 추측도 가능하다.

서버가 믿을 수 있는 것은 **카카오가 서명했거나 카카오에 직접 물어서 확인한 값**뿐이다. 그래서 앱은 회원번호가 아니라 토큰을 보내고, 서버가 그 토큰으로 사용자를 확인한다. 방법은 액세스 토큰을 카카오에 조회하는 것과, OIDC ID 토큰의 서명을 직접 검증하는 것 두 가지다.

## 방법 1: 액세스 토큰을 카카오에 물어보기

카카오는 액세스 토큰 정보 조회 API를 제공한다.

```http
GET https://kapi.kakao.com/v1/user/access_token_info
Authorization: Bearer ${ACCESS_TOKEN}
```

응답에는 회원번호 `id`, 남은 유효 시간(초) `expires_in`, 그리고 토큰을 발급한 앱의 ID `app_id`가 들어 있다. 여기서 중요한 것이 `app_id`다. 토큰이 유효하다는 사실만으로는 **우리 앱에서 발급된 토큰인지** 알 수 없다. 공격자가 자기가 만든 다른 카카오 앱에서 피해자에게 로그인을 받아 얻은 토큰을 우리 서버에 보내면, 그 토큰으로도 `/v2/user/me` 조회는 성공한다. `app_id`를 우리 앱 ID와 비교해야 이런 토큰 치환(Token Substitution)을 막을 수 있다.

오류 코드도 구분한다. 카카오 문서 기준으로 `-401`(HTTP 401)은 토큰이 잘못되었거나 만료된 경우이고, `-2`(HTTP 400)는 인자가 없거나 형식이 잘못된 경우, `-1`(HTTP 400)은 카카오 내부의 일시적 장애다. `-1`은 토큰 문제가 아니므로 클라이언트에 "다시 로그인하라"가 아니라 "잠시 후 재시도"로 응답하는 편이 맞다.

검증이 끝나면 같은 토큰으로 사용자 정보 조회 API(`GET /v2/user/me`)를 호출해 필요한 프로필을 가져온다.

```typescript
@Injectable()
export class KakaoClient {
  constructor(private readonly config: ConfigService) {}

  async verifyAccessToken(accessToken: string): Promise<KakaoProfile> {
    const auth = { Authorization: `Bearer ${accessToken}` };

    const infoRes = await fetch('https://kapi.kakao.com/v1/user/access_token_info', {
      headers: auth,
      signal: AbortSignal.timeout(3000),
    });
    if (infoRes.status === 401) throw new UnauthorizedException('INVALID_KAKAO_TOKEN');
    if (!infoRes.ok) throw new ServiceUnavailableException('KAKAO_UNAVAILABLE');

    const info = (await infoRes.json()) as { id: number; app_id: number };
    if (String(info.app_id) !== this.config.getOrThrow<string>('KAKAO_APP_ID')) {
      throw new UnauthorizedException('FOREIGN_APP_TOKEN');
    }

    const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: auth,
      signal: AbortSignal.timeout(3000),
    });
    if (!meRes.ok) throw new ServiceUnavailableException('KAKAO_UNAVAILABLE');
    const me = (await meRes.json()) as KakaoMeResponse;

    return {
      providerUserId: String(me.id),
      email: me.kakao_account?.is_email_verified ? me.kakao_account.email : undefined,
      nickname: me.kakao_account?.profile?.nickname,
    };
  }
}
```

회원번호는 문서상 `Long` 타입이다. DB와 JWT에는 문자열로 다루는 편이 언어·드라이버 간 정밀도 문제를 피하기 쉽다.

## 방법 2: OIDC ID 토큰의 서명 검증

카카오 로그인 설정에서 OpenID Connect를 활성화하면 로그인 시 ID 토큰이 함께 발급된다. ID 토큰은 카카오가 RS256으로 서명한 JWT이므로, 서버는 카카오에 매번 묻지 않고 서명과 클레임만으로 검증할 수 있다. 카카오 문서가 제시하는 검증 항목은 다음과 같다.

| 항목 | 기대값 |
|---|---|
| `iss` | `https://kauth.kakao.com` |
| `aud` | 우리 앱의 앱 키(SDK 초기화에 쓴 네이티브 앱 키) |
| `exp` | 현재 시각보다 이후 |
| `nonce` | 로그인 요청 때 보낸 값과 일치 |
| 서명 | 헤더의 `kid`에 맞는 공개키로 RS256 검증 |

공개키 목록은 `https://kauth.kakao.com/.well-known/jwks.json`에서, 메타데이터는 `https://kauth.kakao.com/.well-known/openid-configuration`에서 제공한다. 카카오는 공개키를 일정 기간 캐싱해 쓰라고 권장하며, 지나치게 자주 요청하면 차단될 수 있다고 안내한다. `POST /oauth/tokeninfo`라는 ID 토큰 정보 조회 API도 있지만 문서에서 디버깅용으로 설명하므로 운영 검증에는 쓰지 않는다.

`aud`가 방법 1의 `app_id` 비교와 같은 역할을 한다. 다른 앱에서 발급된 ID 토큰은 `aud`가 달라 거부된다. 주의할 점은 `aud`가 숫자 앱 ID가 아니라 **앱 키 문자열**이라는 것이다.

`nonce`는 재전송(Replay) 방지용이다. 서버가 일회용 값을 발급하고, 앱이 그 값을 로그인 요청에 넣는다. Flutter용 카카오 SDK의 `loginWithKakaoTalk`, `loginWithKakaoAccount`는 `nonce` 인자를 받는다. 서버는 ID 토큰의 `nonce`가 자신이 발급했고 아직 사용되지 않은 값인지 확인한 뒤 폐기한다.

Node에서는 `jose` 라이브러리의 `createRemoteJWKSet`이 JWKS 조회와 캐시를 처리한다. 기본 캐시 수명은 10분이고, 모르는 `kid`가 오면 마지막 조회 후 30초(`cooldownDuration`)가 지났을 때만 다시 받아 온다.

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const kakaoJwks = createRemoteJWKSet(new URL('https://kauth.kakao.com/.well-known/jwks.json'));

@Injectable()
export class KakaoIdTokenVerifier {
  constructor(
    private readonly config: ConfigService,
    private readonly nonces: NonceStore,
  ) {}

  async verify(idToken: string): Promise<KakaoProfile> {
    const { payload } = await jwtVerify(idToken, kakaoJwks, {
      issuer: 'https://kauth.kakao.com',
      audience: this.config.getOrThrow<string>('KAKAO_NATIVE_APP_KEY'),
      algorithms: ['RS256'],
      clockTolerance: 30,
    }).catch(() => {
      throw new UnauthorizedException('INVALID_ID_TOKEN');
    });

    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!(await this.nonces.consume(nonce))) {
      throw new UnauthorizedException('INVALID_NONCE');
    }

    return {
      providerUserId: String(payload.sub),
      email: payload.email as string | undefined,
      nickname: payload.nickname as string | undefined,
    };
  }
}
```

`jwtVerify`는 `issuer`, `audience`를 주면 해당 클레임이 반드시 있어야 통과시키고, `exp`도 검사한다. `nonce`는 표준 JWT 검증 항목이 아니라서 직접 확인해야 한다. ID 토큰의 `nickname`, `email` 클레임은 사용자가 해당 동의 항목에 동의했을 때만 들어오고, `email`은 유효한 이메일이 있을 때만 제공된다. ID 토큰에는 `email_verified` 같은 인증 여부 클레임이 없으므로, 인증 여부까지 필요하면 `/v2/user/me`의 `is_email_verified`를 확인한다.

## 두 방식 비교

| 항목 | 액세스 토큰 검증 | ID 토큰 검증 |
|---|---|---|
| 사전 설정 | 없음 | OpenID Connect 활성화 |
| 로그인당 외부 호출 | 2회(정보 조회 + 사용자 조회) | 0회(JWKS 캐시 적중 시) |
| 카카오 장애 영향 | 로그인 불가 | 캐시된 키로 검증 가능 |
| 앱 확인 | `app_id` 직접 비교 | `aud` 클레임 |
| 재전송 방지 | 토큰 만료에 의존 | `nonce`로 일회성 보장 |
| 추가 프로필 | `/v2/user/me`로 동의 항목 전체 | ID 토큰에 담긴 클레임만 |
| 구현 난이도 | 낮음 | JWKS·nonce 관리 필요 |

로그인 빈도가 낮고 프로필을 어차피 조회해야 한다면 방법 1로 충분하다. 외부 의존을 줄이고 재전송까지 막으려면 방법 2가 낫고, 둘을 섞어 ID 토큰으로 신원을 확인한 뒤 필요할 때만 `/v2/user/me`를 부를 수도 있다.

## 계정 연결 모델

신원 확인이 끝나면 "카카오 회원 N번"을 우리 서비스의 사용자와 연결한다. 핵심은 **식별자를 (제공자, 제공자 사용자 ID) 쌍으로 잡는 것**이다. 카카오 회원번호는 문서상 앱별 사용자 고유 ID이고, 다른 제공자(Apple, Google)의 ID와 값이 겹칠 수 있으므로 제공자와 함께 유일 제약을 건다.

```prisma
model User {
  id        String          @id @default(uuid()) @db.Char(36)
  email     String?         @unique @db.VarChar(255)
  createdAt DateTime        @default(now())
  socials   SocialAccount[]
}

model SocialAccount {
  id             String   @id @default(uuid()) @db.Char(36)
  userId         String   @db.Char(36)
  provider       String   @db.VarChar(20)
  providerUserId String   @db.VarChar(64)
  linkedAt       DateTime @default(now())
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerUserId])
  @@index([userId])
}
```

`loginId = "kakao_" + id`처럼 문자열을 합쳐 사용자 테이블 한 컬럼에 넣는 방식도 동작은 하지만, 한 사용자가 여러 제공자를 연결하거나 일반 로그인과 병행하는 순간 표현할 수 없다. 소셜 로그인 사용자에게 의미 없는 비밀번호 해시를 채워 넣어야 하는 문제도 생긴다.

이메일은 식별자로 쓰지 않는다. 카카오 이메일은 사용자가 동의해야 제공되고(`email_needs_agreement`), 다른 계정이 같은 이메일을 쓰게 되면 `is_email_valid`가 `false`가 될 수 있다. 카카오 문서도 이메일이나 전화번호는 바뀔 수 있으므로 서비스 회원 식별자로 쓰지 말라고 안내한다. 특히 "같은 이메일이면 기존 계정에 자동 연결"은 위험하다. 검증되지 않은 이메일로 남의 계정에 붙을 수 있기 때문이다. 자동 연결이 필요하다면 최소한 `is_email_verified`가 `true`일 때로 한정하고, 안전하게는 기존 계정으로 로그인한 상태에서 명시적으로 연결하게 한다.

```typescript
async loginWithKakao(profile: KakaoProfile): Promise<TokenPair> {
  const user = await this.prisma.$transaction(async (tx) => {
    const linked = await tx.socialAccount.findUnique({
      where: { provider_providerUserId: { provider: 'kakao', providerUserId: profile.providerUserId } },
      include: { user: true },
    });
    if (linked) return linked.user;

    return tx.user.create({
      data: {
        socials: { create: { provider: 'kakao', providerUserId: profile.providerUserId } },
      },
    });
  });

  return this.tokens.issue(user.id);
}
```

동시에 두 번 로그인 요청이 오면 둘 다 "없음"을 보고 생성을 시도할 수 있다. 이때 유일 제약이 두 번째 생성을 `P2002` 오류로 막아 주므로, 이를 잡아 다시 조회하면 된다.

## 자체 JWT 발급

카카오 토큰은 카카오 API를 부르기 위한 토큰이지 우리 API의 인증 수단이 아니다. 신원 확인 후에는 서버가 자체 액세스·리프레시 토큰을 발급하고, 이후 모든 요청은 이 토큰으로 인증한다. 이렇게 하면 인증 가드는 로그인 방식(카카오, 일반, Apple)을 알 필요가 없고, 만료·폐기 정책도 우리가 정한다. 토큰 구조와 회전은 [JWT 액세스·리프레시 토큰과 토큰 회전](/2023/03/28/jwt-refresh-token-rotation/)에서 다뤘다.

`sub`에는 카카오 회원번호가 아니라 우리 `User.id`를 넣는다. 제공자 ID가 토큰에 들어가면 계정 연결을 바꾸거나 제공자를 추가할 때 토큰 의미가 흔들린다.

## 카카오 리프레시 토큰을 저장할까

카카오 문서 기준 액세스 토큰 만료는 Android·iOS 12시간, REST API 6시간이고, 리프레시 토큰은 약 2개월이며 남은 기간이 1개월 미만일 때 갱신 시 새로 발급된다.

| 선택 | 장점 | 단점 |
|---|---|---|
| 저장하지 않음 | 유출 위험 없음, 구현 단순 | 서버가 사용자 대신 카카오 API를 부를 수 없음 |
| 서버에 암호화 저장 | 메시지 발송 등 서버 주도 API 호출 가능 | 키 관리, 갱신 시 교체, 유출 시 피해 |

로그인 확인만 필요하다면 저장하지 않는다. 카카오 토큰을 평문 컬럼에 보관해 두면 DB 유출 시 사용자 카카오 계정 API 권한까지 함께 새어 나간다. 연결 해제 같은 서버 작업은 사용자 토큰 대신 어드민 키로 처리할 수 있으므로 저장할 이유가 더 줄어든다.

## 연결 해제와 탈퇴

연결 해제(Unlink)는 사용자의 서비스 동의를 철회하고 해당 앱에 발급된 토큰을 모두 폐기하는 동작이다. 경로는 두 방향이다.

**서비스에서 탈퇴할 때**: 서버가 연결 해제 API를 호출한다. 사용자 토큰이 없어도 어드민 키와 회원번호로 호출할 수 있다. 어드민 키는 절대 클라이언트에 두지 않는다.

```http
POST https://kapi.kakao.com/v1/user/unlink
Authorization: KakaoAK ${ADMIN_KEY}
Content-Type: application/x-www-form-urlencoded

target_id_type=user_id&target_id=1234567890
```

**사용자가 카카오 쪽에서 끊을 때**: 카카오계정의 연결된 서비스 관리, 계정 탈퇴 등으로 연결이 끊기면 카카오가 등록된 URL로 연결 해제 웹훅을 보낸다. 요청에는 `app_id`, `user_id`, `referrer_type`(`ACCOUNT_DELETE`, `UNLINK_FROM_APPS` 등)이 담기고, `Authorization: KakaoAK ${ADMIN_KEY}` 헤더로 카카오가 보낸 요청인지 확인한다. 3초 안에 200으로 응답해야 하므로 무거운 정리 작업은 큐로 넘긴다.

```typescript
@Public()
@Post('webhooks/kakao/unlink')
@HttpCode(200)
async kakaoUnlinked(@Headers('authorization') auth: string, @Body() body: KakaoUnlinkDto) {
  if (auth !== `KakaoAK ${this.config.getOrThrow('KAKAO_ADMIN_KEY')}`) return;
  if (body.app_id !== this.config.getOrThrow('KAKAO_APP_ID')) return;
  await this.accountJobs.enqueueUnlink('kakao', body.user_id);
}
```

웹훅을 받은 뒤의 처리는 서비스 정책이다. 카카오가 유일한 로그인 수단인 사용자라면 탈퇴로 처리하고, 다른 로그인 수단이 있다면 `SocialAccount` 행만 지운다. 우리 서비스가 발급한 리프레시 토큰도 함께 폐기해야 끊긴 계정으로 계속 로그인 상태가 유지되지 않는다.

## 정리

1. 클라이언트가 보낸 회원번호는 믿지 않는다. 서버는 카카오 토큰을 받아 직접 검증한다.
2. 액세스 토큰 방식은 `access_token_info`로 `app_id`를 우리 앱과 비교한 뒤 `/v2/user/me`로 프로필을 읽는다.
3. ID 토큰 방식은 JWKS 공개키로 RS256 서명을 검증하고 `iss`, `aud`(앱 키), `exp`, `nonce`를 확인한다. 공개키는 캐시한다.
4. 계정은 `(provider, providerUserId)` 유일 제약으로 연결하고, 이메일은 식별자나 자동 병합 기준으로 쓰지 않는다.
5. 신원 확인 후에는 `sub`에 우리 사용자 ID를 담은 자체 JWT를 발급한다.
6. 카카오 리프레시 토큰은 서버 주도 API 호출이 필요할 때만 암호화해 저장한다.
7. 탈퇴 시에는 어드민 키로 연결 해제를 호출하고, 카카오 쪽 연결 해제는 웹훅으로 받아 비동기로 정리한다.
