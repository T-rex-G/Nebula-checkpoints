<?php
$host = $_POST['host'];
echo '<pre>' . htmlspecialchars(shell_exec('ping -c 1 ' . $host)) . '</pre>'; // expect: SEC-011
