<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\DB;

Route::middleware(['auth', 'can:admin'])->prefix('admin')->group(function () {
    Route::get('/users', function () {
        return DB::table('users')->get();
    });
    Route::delete('/users/{id}', function ($id) {
        return DB::table('users')->where('id', (int) $id)->delete();
    });
});
