<?php
use App\Lib\Reports;
$reports = new \App\Lib\Reports($pdo);
echo json_encode($reports->forRegion($_GET['region']));
