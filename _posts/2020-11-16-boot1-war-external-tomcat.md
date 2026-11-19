---
layout: post
title: 8088인데 톰캣은 8080이었다
date: 2020-11-16
tags: [spring-boot]
description: Boot 1.5 WAR는 server.port를 안 본다.
---

로컬에서는 `server.port=8088`, `server.context-path=/shop` 으로 잘 떴다. 같은 war를 운영 톰캣에 넣었더니 8080이고, 주소 뒤에 붙는 이름은 war 파일 이름이었다. `application.properties`를 세 번은 고쳤다.

Boot 1.5에서 저 두 값은 내장 톰캣을 띄울 때 쓰인다. 바깥 톰캣이 이미 떠 있고 그 위에 war만 들어가면, 포트는 `server.xml`의 Connector고 컨텍스트 경로는 war 이름이나 톰캣 쪽 설정이다. 프로퍼티가 틀린 게 아니라, 그 값을 읽는 쪽이 실행되지 않았다.

war로 내릴 때 메인 클래스가 `SpringBootServletInitializer`를 상속해야 했다. `configure()`에서 `sources`에 자기 클래스를 넘긴다. 이게 없으면 바깥 톰캣이 부트 애플리케이션을 시작하지 못한다. `java -jar`로 띄울 때는 `main()`만으로 되니까, 로컬에서는 이 차이를 모른다.

pom은 `packaging`을 war로 바꾸고 `spring-boot-starter-tomcat`은 `provided`로 뒀다. 빼지 않으면 내장 톰캣 클래스가 `WEB-INF/lib`에 들어가서 바깥 컨테이너 클래스랑 같이 로드된다. `provided`로 빼면 그 의존성은 `lib-provided`로 가서, 톰캣에 올리는 것과 로컬에서 `java -jar`로 띄우는 것을 한 파일로 할 수 있었다.

운영 포트는 톰캣 Connector를 고쳤다. `server.port`는 로컬용으로 남겨 뒀다.
