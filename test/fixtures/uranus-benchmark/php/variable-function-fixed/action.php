<?php
$format = 'strtoupper';
/* the function is the code's own choice; the caller only gives it a value */
$result = $format($_GET['arg']);
echo htmlspecialchars((string) $result);
