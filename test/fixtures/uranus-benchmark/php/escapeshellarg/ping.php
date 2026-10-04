<?php
$host = escapeshellarg($_POST['host']);
echo '<pre>' . htmlspecialchars(shell_exec('ping -c 1 ' . $host)) . '</pre>';
