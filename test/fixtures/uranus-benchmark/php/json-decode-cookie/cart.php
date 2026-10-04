<?php
$cart = json_decode(base64_decode($_COOKIE['cart']), true);
echo count($cart);
