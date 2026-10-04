<?php
$page = $_GET['page'] ?? 'home';
if (!in_array($page, ['home', 'about', 'contact'], true)) {
    $page = 'home';
    exit;
}
include 'pages/' . $page . '.php';
