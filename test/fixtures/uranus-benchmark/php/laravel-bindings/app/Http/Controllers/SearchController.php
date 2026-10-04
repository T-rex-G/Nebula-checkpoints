<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class SearchController extends Controller
{
    public function index(Request $request)
    {
        return DB::select('SELECT * FROM posts WHERE title LIKE ?', ['%' . $request->input('q') . '%']);
    }
}
