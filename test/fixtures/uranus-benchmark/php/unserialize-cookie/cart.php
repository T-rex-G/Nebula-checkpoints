<?php
$cart = unserialize(base64_decode($_COOKIE['cart'])); // expect: SEC-024
echo count($cart);
