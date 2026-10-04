<?php
$file = $_GET['file'];
echo htmlspecialchars(file_get_contents('/srv/docs/' . $file)); // expect: SEC-022
