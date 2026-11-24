<?php
$name = addslashes($_GET['name']);
echo '<h1>Hello ' . $name . '</h1>'; // expect: SEC-033
