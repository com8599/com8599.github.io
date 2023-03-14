---
layout: post
title: nginx WebSocket 프록시 — Upgrade 헤더와 타임아웃
date: 2023-03-14
tags: [infra]
description: WebSocket이 nginx 뒤에서 연결되지 않거나 60초마다 끊기는 이유와 필요한 설정.
---

WebSocket 서버를 nginx 뒤에 두면 흔히 두 가지 문제가 생긴다. 하나는 연결 자체가 맺어지지 않고 일반 HTTP 응답이 돌아오는 것이고, 다른 하나는 연결은 되는데 아무 메시지도 오가지 않으면 1분쯤 뒤에 끊기는 것이다. 둘 다 nginx가 고장 난 것이 아니라 HTTP 프록시로서의 기본 동작 때문이다. WebSocket이 어떻게 시작되는지부터 보면 필요한 설정이 자연스럽게 나온다.

## WebSocket은 HTTP 요청으로 시작한다

WebSocket(RFC 6455)은 별도 포트나 프로토콜로 접속하지 않는다. 클라이언트가 평범한 HTTP/1.1 GET 요청에 프로토콜 전환을 요청하는 헤더를 붙여 보내고, 서버가 `101 Switching Protocols`로 응답하면 같은 TCP 연결이 그때부터 WebSocket 프레임을 주고받는 통로가 된다. 이 과정을 핸드셰이크(handshake)라고 한다.

```http
GET /chat HTTP/1.1
Host: server.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

`Sec-WebSocket-Accept`는 클라이언트가 보낸 키에 고정 GUID(`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)를 붙여 SHA-1 해시를 구하고 Base64로 인코딩한 값이다. 서버가 WebSocket 요청을 실제로 이해했다는 것을 확인하는 용도이며, 보안 장치는 아니다.

| 헤더 | 역할 |
|---|---|
| `Upgrade: websocket` | 전환하려는 프로토콜 |
| `Connection: Upgrade` | `Upgrade` 헤더가 이 연결 구간에만 해당한다는 표시 |
| `Sec-WebSocket-Key` / `Accept` | 핸드셰이크 확인 |
| `Sec-WebSocket-Version` | 프로토콜 버전, 현재 13 |

## Upgrade와 Connection은 홉 단위 헤더다

HTTP 헤더는 끝단까지 전달되는 엔드투엔드(end-to-end) 헤더와, 바로 옆 연결 구간에만 의미가 있는 홉 단위(hop-by-hop) 헤더로 나뉜다. RFC 9110은 `Connection` 헤더에 나열된 필드를 중개자(프록시)가 전달하기 전에 제거하도록 요구하고, `Upgrade`를 보내는 쪽은 반드시 `Connection`에 `upgrade`를 넣도록 한다. 즉 `Upgrade`는 정의상 프록시를 넘어가지 않는 헤더다.

nginx 문서도 같은 내용을 설명한다. `Upgrade`와 `Connection`은 홉 단위 헤더라 클라이언트에서 백엔드로 전달되지 않으므로, 백엔드가 프로토콜 전환 의도를 알게 하려면 명시적으로 다시 설정해야 한다. 여기에 `proxy_set_header`의 기본값도 겹친다. HTTP/1.x로 프록시할 때 nginx는 원래 요청의 `Host`와 `Connection`을 쓰지 않고 `Host $proxy_host`, `Connection close`로 다시 정의한다. 아무 설정이 없으면 백엔드는 업그레이드 요청이 아니라 "응답 후 닫을 일반 요청"을 받는다.

또 하나는 HTTP 버전이다. RFC 9110은 HTTP/1.0 요청에 들어 있는 `Upgrade` 헤더를 서버가 무시하도록 정한다. 2023년 현재 nginx `proxy_http_version`의 기본값은 `1.0`이므로, 헤더를 넘겨도 버전을 바꾸지 않으면 업그레이드가 성립하지 않는다.

## 기본 설정

nginx는 1.3.13부터 백엔드가 101을 응답하고 클라이언트가 `Upgrade` 헤더로 전환을 요청한 경우, 클라이언트와 백엔드 사이에 터널을 만들어 양방향으로 데이터를 그대로 넘긴다.

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

`$http_upgrade`는 클라이언트 요청의 `Upgrade` 헤더 값이다. 이 설정은 WebSocket 전용 location에는 충분하지만, 같은 location으로 일반 HTTP 요청도 들어온다면 모든 요청에 `Connection: upgrade`가 붙는 문제가 있다.

## map으로 Connection 값을 분기하기

`ngx_http_map_module`의 `map`은 다른 변수 값에 따라 새 변수를 만든다. `http` 컨텍스트에만 쓸 수 있고, 변수는 실제로 사용될 때 평가되므로 선언 자체의 비용은 거의 없다.

```nginx
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen 80;

        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header Host       $host;
            proxy_set_header Upgrade    $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
        }
    }
}
```

| 클라이언트 `Upgrade` 헤더 | `$connection_upgrade` | 백엔드가 받는 `Connection` |
|---|---|---|
| `websocket` | `upgrade` | `Connection: upgrade` |
| 없음(빈 문자열) | `close` | `Connection: close` |

빈 값일 때 `close`를 주는 것은 nginx 기본 동작과 같다. upstream keepalive를 쓰고 있다면 일반 요청에서 연결을 닫지 않도록 `''` 쪽 값을 빈 문자열(`""`)로 두는 경우도 있다. `proxy_set_header`의 값이 빈 문자열이면 해당 헤더를 보내지 않기 때문이다.

`proxy_set_header`의 상속 규칙도 주의해야 한다. 이 지시어는 현재 레벨에 `proxy_set_header`가 하나도 없을 때만 상위 레벨 설정을 물려받는다. `server`에 `X-Forwarded-For`를 설정해 두고 location에 `Upgrade`만 추가하면, 그 location에서는 상위의 헤더 설정이 전부 사라진다. WebSocket location에는 필요한 헤더를 모두 다시 적는다.

## 60초 끊김과 proxy_read_timeout

업그레이드 이후에도 nginx의 타임아웃은 그대로 적용된다.

| 지시어 | 기본값 | 의미 |
|---|---|---|
| `proxy_connect_timeout` | 60s | 백엔드와 연결을 맺는 시간 |
| `proxy_read_timeout` | 60s | 백엔드에서 연속된 두 번의 읽기 사이 간격 |
| `proxy_send_timeout` | 60s | 백엔드로 연속된 두 번의 쓰기 사이 간격 |

`proxy_read_timeout`은 전체 연결 시간이 아니라 **두 번의 읽기 사이** 간격이다. 백엔드가 60초 동안 아무것도 보내지 않으면 nginx가 연결을 닫는다. 채팅방에 아무도 말하지 않는 상황이 바로 이 경우다.

해결 방법은 두 가지다.

- 타임아웃을 늘린다. `proxy_read_timeout 3600s;`처럼 설정하면 1시간 동안 조용해도 끊기지 않는다. 대신 죽은 연결을 감지하는 시점도 그만큼 늦어진다.
- 서버가 주기적으로 데이터를 보낸다. nginx 문서도 백엔드가 WebSocket 핑(ping) 프레임을 주기적으로 보내 타임아웃을 갱신하는 방법을 제시한다.

RFC 6455의 제어 프레임 중 핑은 opcode `0x9`, 퐁(pong)은 `0xA`다. 핑을 받은 쪽은 같은 애플리케이션 데이터를 담은 퐁으로 응답해야 하고, 핑은 연결 유지(keepalive)나 상대가 살아 있는지 확인하는 용도로 쓸 수 있다. 서버가 핑을 보내면 nginx 입장에서는 백엔드로부터 읽기가 발생한 것이고, 클라이언트의 퐁은 백엔드로의 쓰기가 되므로 양쪽 타이머가 모두 갱신된다.

Socket.IO는 자체 하트비트를 쓴다. v4의 기본값은 `pingInterval` 25초, `pingTimeout` 20초로 합이 45초이고, Socket.IO 문서는 `proxy_read_timeout`이 이 합보다 길어야 한다고 안내한다. 기본값끼리는 60초 > 45초로 맞지만, `pingInterval`을 늘렸다면 nginx 쪽도 같이 늘려야 한다.

```nginx
location /socket.io/ {
    proxy_pass http://nodes;
    proxy_http_version 1.1;
    proxy_set_header Host       $host;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

nginx 앞에 클라우드 로드밸런서가 하나 더 있다면 그쪽의 유휴 타임아웃(idle timeout)도 같은 기준으로 맞춘다. 가장 짧은 타임아웃이 실제 끊김 시간을 결정한다.

## 여러 백엔드로 분산할 때

순수 WebSocket은 연결이 한 번 맺어지면 끝날 때까지 같은 백엔드에 붙어 있으므로 라운드 로빈(round robin)으로도 문제가 없다. 문제는 Socket.IO처럼 HTTP 롱 폴링(long polling)으로 시작하거나 폴백(fallback)하는 라이브러리다. 폴링은 여러 개의 독립된 HTTP 요청으로 이뤄지므로, 세션을 만든 서버가 아닌 곳으로 요청이 가면 `Session ID unknown` 같은 오류가 난다. 그래서 같은 클라이언트를 같은 서버로 보내는 스티키 세션(sticky session)이 필요하다.

```nginx
upstream nodes {
    ip_hash;
    server app01:3000;
    server app02:3000;
    server app03:3000;
}
```

| 방식 | 키 | 특징 |
|---|---|---|
| `ip_hash` | IPv4 앞 3옥텟 또는 IPv6 전체 주소 | 같은 /24 대역은 같은 서버로 몰린다 |
| `hash $remote_addr consistent` | 지정한 변수 | 일관된 해싱(ketama)으로 서버 증감 시 재배치가 적다 |
| `sticky cookie` | nginx가 발급한 쿠키 | 2023년 기준 NGINX Plus(상용) 기능 |
| `least_conn` | 활성 연결 수 | 스티키가 아니므로 폴링에는 부적합, 순수 WebSocket에는 적합 |

`ip_hash`나 `hash`는 nginx가 보는 클라이언트 주소를 기준으로 하므로, nginx 앞에 L4/L7 로드밸런서가 있으면 모든 요청이 그 로드밸런서 IP로 보여 한 서버에 몰린다. 이때는 `ngx_http_realip_module`로 실제 클라이언트 주소를 복원하거나, 앞단 로드밸런서에서 스티키를 처리한다.

Socket.IO 클라이언트를 `transports: ["websocket"]`으로 설정해 폴링을 끄면 스티키 세션이 필요 없다. 대신 WebSocket이 막힌 네트워크에서는 폴백 없이 연결에 실패한다. 또 스티키 세션은 연결 라우팅만 해결할 뿐, 다른 서버에 붙은 클라이언트에게 브로드캐스트하려면 Redis 어댑터(adapter) 같은 서버 간 메시지 전달 수단이 별도로 필요하다.

## 버퍼링

`proxy_buffering`의 기본값은 `on`이다. nginx는 백엔드 응답을 버퍼에 최대한 빨리 받아 두고 클라이언트에게 내보내며, 버퍼가 모자라면 임시 파일까지 쓴다. 101 응답 이후의 WebSocket 구간은 nginx가 양방향 터널로 데이터를 넘기는 방식이라 이 응답 버퍼링과는 동작이 다르다.

버퍼링이 문제가 되는 것은 WebSocket이 아니라 같은 경로로 오가는 스트리밍 HTTP 응답이다. 서버 전송 이벤트(Server-Sent Events)나 청크 단위로 흘려보내는 응답은 버퍼링 때문에 클라이언트에 늦게 도착할 수 있다. 이런 location에는 `proxy_buffering off;`를 두거나, 백엔드가 응답에 `X-Accel-Buffering: no` 헤더를 넣어 응답 단위로 끌 수 있다.

```nginx
location /events/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## 증상별 원인

| 증상 | 원인 | 설정 |
|---|---|---|
| 101 대신 200/400/426 응답 | `Upgrade`, `Connection` 미전달 또는 HTTP/1.0 | `proxy_http_version 1.1`, `proxy_set_header Upgrade/Connection` |
| 일부 location에서만 헤더 누락 | `proxy_set_header` 상속 규칙 | location에 헤더 전체를 다시 선언 |
| 유휴 상태에서 약 60초 후 끊김 | `proxy_read_timeout` 기본값 | 타임아웃 증가 또는 서버 측 핑 |
| Socket.IO `Session ID unknown` | 폴링 요청이 다른 서버로 분산 | `ip_hash` / `hash` 또는 WebSocket 전용 전송 |
| 다른 서버 클라이언트에게 이벤트 미전달 | 서버 간 브로드캐스트 부재 | Redis 등 어댑터 |

## 정리

- WebSocket은 HTTP/1.1 `Upgrade` 요청과 101 응답으로 시작하며, `Upgrade`와 `Connection`은 홉 단위 헤더라 프록시를 넘어가지 않는다.
- nginx에는 `proxy_http_version 1.1`과 `Upgrade`, `Connection` 헤더를 명시해야 하고, `map $http_upgrade $connection_upgrade`로 일반 요청과 업그레이드 요청을 구분한다.
- `proxy_read_timeout`(기본 60초)은 읽기 사이 간격이므로, 타임아웃을 늘리거나 서버가 핑을 보내 연결을 유지한다. Socket.IO는 `pingInterval + pingTimeout`보다 길게 둔다.
- 폴링 전송을 쓰는 Socket.IO는 스티키 세션이 필요하고, 서버 간 이벤트 전달은 어댑터로 별도 해결한다.
- 응답 버퍼링은 WebSocket 터널보다 SSE 같은 스트리밍 HTTP 응답에서 문제가 되며, `proxy_buffering off`나 `X-Accel-Buffering`으로 제어한다.
