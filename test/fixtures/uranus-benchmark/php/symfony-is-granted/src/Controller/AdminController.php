<?php
namespace App\Controller;

use Doctrine\DBAL\Connection;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Http\Attribute\IsGranted;

#[Route('/admin')]
#[IsGranted('ROLE_ADMIN')]
class AdminController
{
    #[Route('/purge', methods: ['DELETE'])]
    public function purge(Connection $connection): JsonResponse
    {
        $connection->executeStatement('DELETE FROM sessions WHERE expires_at < NOW()');
        return new JsonResponse(['ok' => true]);
    }
}
