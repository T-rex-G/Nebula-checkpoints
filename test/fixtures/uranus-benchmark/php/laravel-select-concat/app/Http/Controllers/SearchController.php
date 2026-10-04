<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class SearchController extends Controller
{
    public function index(Request $request)
    {
        $term = $request->input('q');
        return DB::select("SELECT * FROM posts WHERE title LIKE '%" . $term . "%'"); // expect: SEC-001
    }
}
