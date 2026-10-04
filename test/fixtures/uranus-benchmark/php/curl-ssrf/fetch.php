<?php
$handle = curl_init($_GET['url']); // expect: SEC-021
curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
echo htmlspecialchars(curl_exec($handle));
