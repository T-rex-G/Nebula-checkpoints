<?php
require_once 'lib/Users.php';
$u = new Users($db);
$r = $u->find($_GET['name']);
