---
layout: post
title: bin이 옆방에 있었다
date: 2020-04-16
tags: [spring, xml]
description: ContextLoaderListener랑 DispatcherServlet이 컨텍스트를 하나씩 만든다.
---

web.xml을 오래 안 보다가 다시 열었다. 리스너 하나, 서블릿 하나. 설정 파일도 두 개였다. `applicationContext.xml`, `servlet-context.xml`. 예전에 복사해 둔 모양 그대로였다.

리스너는 `ContextLoaderListener`다. 톰캣이 웹앱을 올릴 때 이쪽이 먼저 뜬다. 여기서 만든 게 루트 컨텍스트고, 서비스랑 트랜잭션 매니저, 데이터소스가 여기 들어 있다. `DispatcherServlet`은 자기 컨텍스트를 따로 만든다. 컨트롤러랑 `ViewResolver`는 보통 이쪽이다. 서블릿 컨텍스트의 부모가 루트다. 자식은 부모 bin을 보고, 부모는 자식 bin을 못 본다.

이걸 거꾸로 넣으면 증상이 이상해진다. 서비스 패키지를 `servlet-context.xml`의 `component-scan`에만 넣었다. 컨트롤러 주입은 된다. 그런데 같은 웹앱의 필터가 루트에서 그 서비스를 꺼내면 없다. `WebApplicationContextUtils.getRequiredWebApplicationContext()`가 돌려주는 건 루트다. 로그는 `NoSuchBeanDefinitionException`인데 클래스는 프로젝트 안에 있다. 처음엔 스캔 경로 오타부터 봤다.

반대로 루트에서 컨트롤러 패키지까지 스캔하면 매핑이 두 개가 된다. 컨트롤러 스캔은 서블릿 설정에만 두는 쪽이 덜 꼬였다.

트랜잭션 설정도 컨텍스트를 따라간다. `tx:annotation-driven`을 `servlet-context.xml`에만 넣어 두면 그 안의 bin에만 걸린다. 서비스가 루트에 있으면 어노테이션을 붙여도 프록시가 안 생긴다. 롤백이 안 될 때 메서드부터 의심했는데, 설정이 다른 파일에 있었다.

부모 자식이라는 말만 남아 있고 어느 쪽이 부모인지 헷갈렸다. 먼저 뜨는 쪽이 부모다.
