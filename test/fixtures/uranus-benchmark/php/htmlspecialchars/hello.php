<?php
$name = htmlspecialchars($_GET['name'], ENT_QUOTES, 'UTF-8');
echo "<h1>Hello $name</h1>";
