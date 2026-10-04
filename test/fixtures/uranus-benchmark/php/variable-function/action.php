<?php
$action = $_GET['action'];
/* a function chosen by the caller and called: not traced yet */
$result = $action($_GET['arg']); // known-miss: SEC-010
echo htmlspecialchars((string) $result);
