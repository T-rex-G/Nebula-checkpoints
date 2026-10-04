<?php
namespace App\Services;

use Illuminate\Support\Facades\DB;

class ReportService
{
    public function forRegion($region)
    {
        return DB::select("SELECT * FROM reports WHERE region = '" . $region . "'"); // expect: SEC-001
    }
}
