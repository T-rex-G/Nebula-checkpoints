<?php
$reports = new Reports($pdo);
echo json_encode($reports->forRegion($_GET['region']));
