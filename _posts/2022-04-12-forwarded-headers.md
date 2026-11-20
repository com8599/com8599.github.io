---
layout: post
title: 리버스 프록시 뒤의 Spring Boot — X-Forwarded 헤더
date: 2022-04-12
tags: [infra, spring-boot]
description: TLS를 프록시에서 종료하면 애플리케이션은 원래 요청 정보를 헤더로만 알 수 있다.
---

nginx나 로드밸런서에서 HTTPS를 종료하고 내부에는 HTTP로 넘기는 구성이 일반적이다. 이때 애플리케이션이 보는 요청은 `http://localhost:8080`이다. 원래 요청 정보를 전달하지 않으면 리다이렉트 URL, 보안 판단, 클라이언트 IP가 모두 틀어진다.

## 영향을 받는 것

| API | 프록시 뒤에서 잘못 나오는 값 |
|---|---|
| `request.getScheme()`, `isSecure()` | `http`, `false` |
| `request.getServerName()`, `getServerPort()` | 내부 호스트, 8080 |
| `request.getRemoteAddr()` | 프록시 IP |
| 리다이렉트 URL 생성 | `http://내부호스트/...` |

Spring Security의 `requiresChannel().anyRequest().requiresSecure()`가 켜져 있으면, 앱은 요청을 HTTP로 보고 HTTPS로 리다이렉트하고, 프록시는 다시 HTTP로 넘기는 **무한 리다이렉트**가 생긴다.

## 헤더

| 헤더 | 내용 |
|---|---|
| `X-Forwarded-For` | 클라이언트 IP 체인 |
| `X-Forwarded-Proto` | 원래 스킴(scheme) |
| `X-Forwarded-Host`, `X-Forwarded-Port` | 원래 호스트, 포트 |
| `Forwarded` | 위 내용을 하나로 표준화한 헤더(RFC 7239) |

## nginx 설정

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Port  $server_port;
}
```

## Spring Boot 설정

```properties
server.forward-headers-strategy=native
```

| 값 | 동작 |
|---|---|
| `native` | 서블릿 컨테이너가 처리. Tomcat은 `RemoteIpValve` 사용 |
| `framework` | Spring의 `ForwardedHeaderFilter`가 처리 |
| `none` | 무시 |

Cloud Foundry나 Heroku에서 실행되면 기본값이 `native`이고, 그 외에는 `none`이다. 일반 EC2 + nginx 구성에서는 직접 켜야 한다.

Tomcat을 쓰면서 프록시에서 TLS를 종료한다면 `server.tomcat.redirect-context-root=false`로 두어, 리다이렉트 전에 `X-Forwarded-Proto`가 반영되게 한다.

## 신뢰 범위

`X-Forwarded-*`는 클라이언트가 임의로 넣을 수 있다. 신뢰할 프록시를 제한해야 IP 위조를 막을 수 있다. Spring Boot의 기본값은 10/8, 192.168/16, 172.16/12, 169.254/16, 127/8, 100.64/10과 IPv6 루프백(loopback, `::1`) 같은 사설·링크 로컬·루프백 대역을 모두 신뢰하므로, 필요하면 실제 프록시 대역으로 좁힌다.

```properties
server.tomcat.remoteip.internal-proxies=10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|127\\.0\\.0\\.1
```

`RemoteIpValve`는 이 범위의 프록시가 보낸 헤더만 반영한다. 프록시가 외부 요청의 `X-Forwarded-For`를 덮어쓰게 하는 것(`$remote_addr`로 새로 설정)도 방법이다.

## HTTPS 강제는 어디서

프록시가 TLS를 종료한다면 HTTP → HTTPS 리다이렉트도 프록시에서 처리하는 편이 단순하다. 애플리케이션에서는 HSTS 헤더 정도만 담당한다.

```nginx
server {
    listen 80;
    return 301 https://$host$request_uri;
}
```
