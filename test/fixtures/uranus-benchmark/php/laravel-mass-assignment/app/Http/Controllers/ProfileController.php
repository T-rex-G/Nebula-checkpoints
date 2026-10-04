<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;

class ProfileController extends Controller
{
    public function update(Request $request)
    {
        return $request->user()->update($request->all()); // expect: SEC-028 to-confirm
    }
}
