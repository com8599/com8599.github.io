---
layout: post
title: axios에 넣은 CORS는 소용없었다
date: 2021-02-09
tags: [react, cors]
description: Access-Control-Allow-Origin은 요청에 적어도 브라우저가 안 본다.
---

화면은 3000번, API는 8080번. 콘솔에 `No 'Access-Control-Allow-Origin'`이 떴다. 그래서 axios header에 그 값을 넣었다. `http://localhost:3000`이라고 적고, methods도 적었다. 그대로였다.

그 헤더는 응답에 있어야 한다. 브라우저가 서버 답을 읽고, 이 출처를 허용하는지 본다. 요청에 내가 적어 둔 문장은 서버가 한 말이 아니라서 검사에 안 들어간다.

Boot 쪽에서 `http://localhost:3000`을 허용하자 그때 열렸다. 개발할 때만 그 주소가 맞고, 배포하면 출처가 바뀐다. 요청 헤더에 미리 적어 두는 방식으로는 그 차이를 메울 수 없다.
