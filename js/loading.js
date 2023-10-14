'use strict';

$(window).on('load', function() {
  $('#loadingScreen').fadeOut('slow');
});

$('a').on('click', function(event) {
  event.preventDefault(); // デフォルトのページ遷移を一時的に停止
  var href = $(this).attr('href');

  $('#loadingScreen').fadeIn('fast'); // ローディング画面をすぐに表示

  setTimeout(function() {
      window.location = href; // 1秒後にページ遷移
  }, 750);
});

