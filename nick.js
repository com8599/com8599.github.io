
  var name = '';  
  function nyehuing(length) {
    for(var i = 0; i < length; i++) {
      name += String.fromCharCode(Math.floor(Math.random()*11171)+44032);
    }
    var getSpan = document.getElementsByClassName('spanName');
    for(var i:getSpan){
      i.innerHTML=name;
    }
    return name;
  }
  
  function relocation(){
    if(name != ''){
      return 'https://maple.gg/u/'+name;
    }
  }
//https://maplestory.nexon.com/Ranking/World/Total?page=6875021
