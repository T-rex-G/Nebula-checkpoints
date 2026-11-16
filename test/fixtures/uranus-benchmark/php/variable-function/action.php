<?php
$action = $_GET['action'];
/* a function chosen by the caller and called */
$result = $action($_GET['arg']); // expect: SEC-010
echo htmlspecialchars((string) $result);
