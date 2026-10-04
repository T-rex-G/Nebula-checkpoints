<?php
namespace App\Controller;

use Doctrine\DBAL\Connection;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

class ReportController
{
    #[Route('/reports', methods: ['GET'])]
    public function index(Request $request, Connection $connection): JsonResponse
    {
        $region = $request->query->get('region');
        return new JsonResponse($connection->fetchAllAssociative("SELECT * FROM reports WHERE region = '" . $region . "'")); // expect: SEC-001
    }
}
