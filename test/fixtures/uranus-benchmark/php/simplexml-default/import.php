<?php
$feed = simplexml_load_string(file_get_contents('php://input'));
echo htmlspecialchars((string) $feed->title);
