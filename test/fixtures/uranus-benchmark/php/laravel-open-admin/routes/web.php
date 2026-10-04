<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\DB;

Route::get('/admin/users', function () { // expect: ACC-003
    return DB::table('users')->get();
});
Route::middleware('auth')->get('/dashboard', function () {
    return view('dashboard');
});
