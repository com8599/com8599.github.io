---
layout: post
title: React 어드민의 권한별 라우트 보호(Protected Route)
date: 2023-12-12
tags: [react]
description: React Router v6에서 로그인 여부와 역할별 권한으로 라우트를 막는 패턴과, 클라이언트 가드가 보안 경계가 아닌 이유.
---

어드민 화면은 로그인한 사용자만 들어갈 수 있어야 하고, 같은 로그인 사용자라도 역할(role)에 따라 볼 수 있는 메뉴와 할 수 있는 작업이 다르다. React 같은 SPA는 라우팅이 브라우저 안에서 일어나므로, 화면 접근을 막는 코드를 라우터 단에 직접 둬야 한다. 이 글은 React Router v6(6.4 이상의 data router 포함)에서 쓰는 보호 라우트(protected route) 패턴과 그 한계를 정리한다.

## 인증과 인가

두 단어는 비슷하지만 묻는 질문이 다르다.

| 구분 | 인증(Authentication) | 인가(Authorization) |
|---|---|---|
| 질문 | 누구인가 | 이 작업을 해도 되는가 |
| 근거 | 비밀번호, 세션 쿠키, 토큰 | 역할, 권한, 리소스 소유 관계 |
| 실패 시 HTTP 상태 | 401 Unauthorized | 403 Forbidden |
| 화면 처리 | 로그인 페이지로 이동 | 권한 없음 안내, 메뉴 숨김 |

라우트 가드도 두 단계로 나눈다. 먼저 로그인 여부를 확인하고, 그 다음 특정 화면에 필요한 권한이 있는지 확인한다. 로그인했지만 권한이 없는 사용자를 로그인 페이지로 보내면 다시 로그인해도 같은 곳으로 돌아오는 루프가 생기므로, 두 경우는 다른 화면으로 처리한다.

## RBAC 모델

역할 기반 접근 제어(Role-Based Access Control, RBAC)는 사용자에게 역할을 주고, 역할에 권한을 묶는 방식이다. 화면 코드가 역할 이름(`admin`)을 직접 비교하면 역할이 늘어날 때마다 조건문을 고쳐야 하므로, 화면은 **권한(permission)** 단위로 검사하고 역할-권한 매핑은 한 곳에 둔다.

```ts
// auth/permissions.ts
export type Permission =
  | 'user:read'
  | 'user:write'
  | 'order:read'
  | 'order:refund'
  | 'setting:write';

export type Role = 'admin' | 'manager' | 'viewer';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['user:read', 'user:write', 'order:read', 'order:refund', 'setting:write'],
  manager: ['user:read', 'order:read', 'order:refund'],
  viewer: ['user:read', 'order:read'],
};

export interface CurrentUser {
  id: number;
  name: string;
  roles: Role[];
}

export function hasPermission(user: CurrentUser | null, permission: Permission) {
  if (!user) return false;
  return user.roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
```

실무에서는 매핑을 프론트엔드에 하드코딩하기보다 로그인 후 서버가 내려주는 권한 목록을 그대로 쓰는 편이 낫다. 권한 정책이 서버 한 곳에서만 바뀌기 때문이다. 이 글의 예제는 구조를 보이기 위해 매핑을 코드에 두었다.

## 인증 상태: 로딩을 구분한다

새로고침 직후에는 메모리에 사용자 정보가 없다. 쿠키나 토큰으로 `/me`를 호출해 사용자를 복원하기 전에 가드가 "로그인 안 됨"으로 판단하면, 로그인된 사용자도 매번 로그인 페이지로 튕긴다. 인증 상태는 최소 세 가지로 둔다.

```tsx
// auth/AuthProvider.tsx
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CurrentUser } from './permissions';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  setUser: (user: CurrentUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((me: CurrentUser | null) => {
        setUser(me);
        setStatus(me ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => setStatus('unauthenticated'));
  }, []);

  const value = useMemo(
    () => ({
      status,
      user,
      setUser: (next: CurrentUser | null) => {
        setUser(next);
        setStatus(next ? 'authenticated' : 'unauthenticated');
      },
    }),
    [status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

`value`를 JSX 안에서 객체 리터럴로 만들지 않고 `useMemo`로 먼저 만든 이유는 렌더링마다 새 객체가 생겨 모든 소비 컴포넌트가 다시 렌더링되는 것을 막기 위해서다.

## 패턴 1: 감싸는 컴포넌트와 Navigate

가장 단순한 형태는 보호할 요소를 감싸는 컴포넌트다. `<Navigate>`는 렌더링되는 순간 위치를 바꾸는 컴포넌트로, `useNavigate`를 감싼 것이며 `to`, `replace`, `state`를 props로 받는다.

```tsx
// auth/RequireAuth.tsx
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <p>확인 중</p>;

  if (status === 'unauthenticated') {
    const redirectState = { from: location };
    return <Navigate to="/login" replace state={redirectState} />;
  }

  return <>{children}</>;
}
```

```tsx
<Route
  path="/users"
  element={
    <RequireAuth>
      <UserListPage />
    </RequireAuth>
  }
/>
```

- `replace`를 주면 현재 히스토리 항목을 교체한다. 주지 않으면 보호된 주소가 히스토리에 남아, 로그인 페이지에서 뒤로 가기를 누를 때 다시 가드에 걸려 로그인 페이지로 돌아오는 현상이 생긴다.
- `state`에 원래 위치(`location`)를 담아 로그인 후 돌아갈 곳을 전달한다. `state`는 URL에 드러나지 않고 히스토리 항목에 저장된다.

라우트마다 감싸야 하므로 보호할 화면이 많으면 반복이 생긴다.

## 패턴 2: 레이아웃 라우트와 Outlet

v6는 `path` 없이 `element`만 가진 레이아웃 라우트(layout route)를 지원한다. 부모 라우트 요소가 `<Outlet />`을 렌더링하면 매칭된 자식 라우트가 그 자리에 그려진다. 가드를 레이아웃 라우트로 만들면 하위 라우트 전체를 한 번에 보호할 수 있다.

```tsx
// auth/guards.tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { hasPermission } from './permissions';
import type { Permission } from './permissions';

export function AuthGuard() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <p>확인 중</p>;
  if (status === 'unauthenticated') {
    const redirectState = { from: location };
    return <Navigate to="/login" replace state={redirectState} />;
  }
  return <Outlet />;
}

export function PermissionGuard({ permission }: { permission: Permission }) {
  const { user } = useAuth();
  if (!hasPermission(user, permission)) {
    return <Navigate to="/403" replace />;
  }
  return <Outlet />;
}
```

```tsx
// App.tsx
import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/403" element={<ForbiddenPage />} />

      <Route element={<AuthGuard />}>
        <Route element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />

          <Route element={<PermissionGuard permission="user:read" />}>
            <Route path="users" element={<UserListPage />} />
          </Route>

          <Route element={<PermissionGuard permission="setting:write" />}>
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
```

라우트 트리를 보면 어떤 화면이 어떤 권한을 요구하는지 한눈에 드러난다. 새 화면을 추가할 때 적절한 가드 아래에 넣기만 하면 된다. `PermissionGuard`는 `AuthGuard` 안쪽에 있으므로 사용자 정보가 이미 확정된 뒤에만 실행된다.

## 원래 위치로 돌아가기

로그인 페이지는 `useLocation()`으로 가드가 넘긴 `state`를 읽고, 로그인에 성공하면 그 위치로 이동한다.

```tsx
// pages/LoginPage.tsx
import { useLocation, useNavigate } from 'react-router-dom';
import type { Location } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();

  const fromLocation = (location.state as { from?: Location } | null)?.from;
  const from = fromLocation
    ? `${fromLocation.pathname}${fromLocation.search}${fromLocation.hash}`
    : '/';

  const handleSubmit = async (form: FormData) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) return;
    setUser(await res.json());
    navigate(from, { replace: true });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit(new FormData(e.currentTarget));
      }}
    >
      <input name="email" />
      <input name="password" type="password" />
      <button type="submit">로그인</button>
    </form>
  );
}
```

- `pathname`만 쓰면 `/users?page=3`의 쿼리 문자열이 사라진다. `search`와 `hash`도 함께 복원한다.
- 로그인 후에도 `replace: true`로 이동해, 뒤로 가기로 로그인 페이지에 돌아가지 않게 한다.
- `location.state`는 히스토리에 저장되므로 새로고침해도 유지되지만, 주소를 직접 입력하거나 새 탭에서 열면 비어 있다. 기본값(`'/'`)을 항상 둔다.

## 패턴 3: data router의 loader에서 redirect

React Router 6.4부터 `createBrowserRouter`와 `RouterProvider`로 구성하는 data router에서는 라우트마다 `loader`를 둘 수 있다. loader는 컴포넌트가 렌더링되기 전에 실행되므로, 권한이 없으면 화면을 그리기 전에 `redirect()`로 돌려보낼 수 있다. 공식 문서도 데이터에 따른 이동은 컴포넌트의 `useNavigate`보다 loader와 action의 `redirect`를 권장한다.

```tsx
// router.tsx
import { createBrowserRouter, redirect } from 'react-router-dom';
import type { LoaderFunctionArgs } from 'react-router-dom';
import { hasPermission } from './auth/permissions';
import type { CurrentUser, Permission } from './auth/permissions';

async function getCurrentUser(): Promise<CurrentUser | null> {
  const res = await fetch('/api/me', { credentials: 'include' });
  return res.ok ? res.json() : null;
}

async function requireUser(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    const url = new URL(request.url);
    const params = new URLSearchParams();
    params.set('redirectTo', url.pathname + url.search);
    throw redirect(`/login?${params.toString()}`);
  }
  return user;
}

function requirePermission(permission: Permission) {
  return async ({ request }: LoaderFunctionArgs) => {
    const user = await requireUser(request);
    if (!hasPermission(user, permission)) throw redirect('/403');
    return null;
  };
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/403', element: <ForbiddenPage /> },
  {
    path: '/',
    element: <AdminLayout />,
    loader: async ({ request }) => requireUser(request),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'users', element: <UserListPage />, loader: requirePermission('user:read') },
      { path: 'settings', element: <SettingsPage />, loader: requirePermission('setting:write') },
    ],
  },
]);
```

```tsx
// main.tsx
import { RouterProvider } from 'react-router-dom';
import { router } from './router';

root.render(<RouterProvider router={router} />);
```

`redirect(url)`은 `Location` 헤더와 302 상태를 가진 `Response`를 만드는 단축 함수다. loader에서 반환해도 되고 throw해도 된다. throw하면 헬퍼 함수 깊은 곳에서도 호출 스택을 바로 빠져나갈 수 있어 위처럼 `requireUser`로 묶기 편하다.

주의할 점이 두 가지 있다.

- **매칭된 loader는 병렬로 실행된다.** 부모 loader가 redirect를 던져도 자식 loader는 이미 함께 시작된 상태다. 부모 가드만 믿고 자식 loader에서 바로 민감한 API를 호출하면 요청 자체는 나간다. 자식 loader도 `requireUser`를 거치게 하고, 무엇보다 서버가 그 요청을 거부해야 한다.
- **`redirectTo`는 검증한다.** 쿼리 문자열은 누구나 바꿀 수 있으므로 `?redirectTo=https://evil.example`을 그대로 이동하면 오픈 리다이렉트(open redirect)가 된다. `/`로 시작하는 내부 경로만 허용하되, 브라우저가 다른 호스트로 해석하는 `//`와 `/\`로 시작하는 값은 거부한다.

```ts
export function safeRedirectPath(value: string | null, fallback = '/') {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  return value;
}
```

이 방식에서는 로그인 페이지가 `location.state` 대신 `useSearchParams()`로 `redirectTo`를 읽고, `safeRedirectPath`를 거친 값으로 이동한다.

| 방식 | 판정 시점 | 원래 위치 전달 | 적합한 경우 |
|---|---|---|---|
| 감싸는 컴포넌트 | 렌더링 중 | `Navigate`의 `state` | 보호할 화면이 몇 개뿐일 때 |
| 레이아웃 라우트 + `Outlet` | 렌더링 중 | `Navigate`의 `state` | `<Routes>` 기반 앱 전체 |
| loader + `redirect` | 렌더링 전 | 쿼리 문자열 | data router를 쓰고, 화면 데이터도 loader로 불러올 때 |

## 권한별 메뉴 렌더링

권한이 없는 화면은 메뉴에서도 보이지 않아야 한다. 메뉴 정의에 필요한 권한을 함께 적고 필터링하면, 라우트 가드와 메뉴가 같은 권한 이름을 쓰게 된다.

```tsx
// widgets/SideMenu.tsx
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { hasPermission } from '../auth/permissions';
import type { Permission } from '../auth/permissions';

interface MenuItem {
  to: string;
  label: string;
  permission?: Permission;
}

const MENU: MenuItem[] = [
  { to: '/', label: '대시보드' },
  { to: '/users', label: '사용자', permission: 'user:read' },
  { to: '/orders', label: '주문', permission: 'order:read' },
  { to: '/settings', label: '설정', permission: 'setting:write' },
];

export function SideMenu() {
  const { user } = useAuth();
  const visible = MENU.filter((item) => !item.permission || hasPermission(user, item.permission));

  return (
    <nav>
      {visible.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

버튼 단위 제어는 작은 컴포넌트로 감싼다.

```tsx
export function Can({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { user } = useAuth();
  return hasPermission(user, permission) ? <>{children}</> : null;
}

<Can permission="order:refund">
  <button onClick={refund}>환불</button>
</Can>
```

## 클라이언트 가드는 UX일 뿐이다

지금까지의 코드는 모두 브라우저에서 실행된다. 사용자는 개발자 도구로 상태를 바꾸거나, 번들 JS를 읽어 API 주소를 알아내거나, 화면을 거치지 않고 `curl`로 API를 직접 호출할 수 있다. 메뉴를 숨기고 라우트를 막아도 `DELETE /api/users/3` 요청 자체를 막지는 못한다.

OWASP Authorization Cheat Sheet는 클라이언트 측 접근 제어 검사에 절대 의존하지 말라고(never rely on client-side access control checks) 명시한다. 같은 문서의 권고 중 어드민 개발과 직접 관련된 항목은 다음과 같다.

- **기본 거부(Deny by Default)**: 명시적으로 허용되지 않은 접근은 거부한다.
- **모든 요청에서 권한 검증(Validate the Permissions on Every Request)**: 일부 엔드포인트만 검사하는 것으로는 부족하다.
- **최소 권한(Least Privilege)**: 업무에 필요한 최소 권한만 준다.
- **추측 가능한 ID 보호**: `/api/orders/1001`의 id를 바꿔 남의 데이터를 조회하지 못하도록 리소스 소유 관계까지 확인한다. 역할만 보는 RBAC로는 이런 검사를 표현하기 어려워, 같은 문서는 애플리케이션 개발에서 속성 기반(ABAC)·관계 기반(ReBAC) 접근 제어를 우선 고려하라고 권한다.

| 위치 | 역할 | 우회 가능 여부 |
|---|---|---|
| 클라이언트 라우트 가드, 메뉴 숨김 | 길을 안내하고 쓸 수 없는 기능을 감춤 | 가능 |
| API 서버의 인가 검사 | 요청마다 사용자·권한·리소스를 확인하고 403 반환 | 불가능해야 함 |

클라이언트 가드는 서버 정책을 **반영**하는 것이지 **대신**하는 것이 아니다. 서버가 403을 돌려줬을 때 화면이 이를 처리하도록(권한 없음 안내, 메뉴 갱신) 만들어 두면, 두 정책이 어긋나도 안전한 쪽으로 동작한다.

## 토큰 만료 처리

로그인 상태는 영원하지 않다. 액세스 토큰(access token)이 만료되거나, 다른 관리자가 사용자의 역할을 바꾸면 클라이언트가 가진 정보가 낡는다.

- **401 응답**: API 클라이언트 공통 처리에서 리프레시 토큰(refresh token)으로 재발급을 시도하고, 실패하면 인증 상태를 `unauthenticated`로 바꾼다. 상태가 바뀌면 `AuthGuard`가 현재 위치를 `state`에 담아 로그인 페이지로 보내므로, 재로그인 후 하던 화면으로 돌아온다. 동시에 여러 요청이 401을 받을 수 있으므로 재발급 요청은 하나로 묶는다.
- **403 응답**: 인증은 유효하지만 권한이 없다는 뜻이다. 로그인 페이지가 아니라 권한 없음 화면으로 보내고, `/me`를 다시 불러 권한 목록과 메뉴를 갱신한다.
- **JWT의 `exp` 확인**: 클라이언트에서 디코딩한 만료 시각은 "곧 만료되니 미리 갱신한다" 같은 UX 판단에만 쓴다. 서명 검증 없이 읽은 값이므로 권한 판단 근거가 될 수 없다.
- **토큰 보관 위치**: `localStorage`에 둔 토큰은 XSS가 발생하면 스크립트로 읽힌다. 가능하면 `HttpOnly`, `Secure`, `SameSite` 속성을 준 쿠키로 서버가 관리하게 하고, 이 경우 CSRF 방어를 함께 고려한다.

| 상황 | 서버 응답 | 클라이언트 처리 |
|---|---|---|
| 로그인하지 않음 | 401 | 로그인 페이지, 원래 위치 보존 |
| 액세스 토큰 만료 | 401 | 재발급 후 재시도, 실패 시 로그인 페이지 |
| 권한 없음 | 403 | 권한 없음 화면, 권한 정보 다시 조회 |
| 역할 변경 | 다음 요청에서 403 | 메뉴와 가드가 새 권한으로 다시 계산 |

## 정리

- 인증은 "누구인가", 인가는 "해도 되는가"다. 미로그인은 로그인 페이지로, 권한 없음은 403 화면으로 분리한다.
- 화면은 역할 이름이 아니라 권한 단위로 검사하고, 역할-권한 매핑은 한 곳(가능하면 서버)에 둔다.
- 인증 상태에 `loading`을 두어, 사용자 복원 전에 가드가 로그인 페이지로 보내지 않게 한다.
- `<Routes>` 기반 앱은 `<Navigate replace state={...}>`를 반환하는 레이아웃 라우트와 `<Outlet />`으로 하위 라우트를 한 번에 보호한다. `state`에 넣을 객체는 변수로 먼저 만든다.
- data router에서는 loader에서 `redirect()`를 던져 렌더링 전에 막는다. loader는 병렬로 실행되므로 자식 loader도 검사하고, `redirectTo`는 내부 경로만 허용한다.
- 메뉴와 버튼도 같은 권한 이름으로 필터링한다.
- 클라이언트 가드는 UX다. 실제 인가는 서버가 모든 요청에서 기본 거부 원칙으로 수행해야 한다.
