<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Órdenes de trabajo de una sala: crear o editar (save), cambiar estado (status) y borrar (delete).
 * Cada cambio sincroniza el periodo de mantenimiento de Zabbix de la orden y queda en el registro de auditoría.
 * Requiere Administrador con permiso de edición de la sala; el mantenimiento además exige que el usuario
 * tenga permiso de escritura sobre esos hosts en Zabbix (lo valida la API de Zabbix).
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

use Modules\LakaInfra3D\Includes\{
	Config,
	History,
	I18n,
	Layout,
	WorkOrders
};

class WorkOrderSave extends CController {

	protected function checkInput(): bool {
		$fields = [
			'op' => 'required|in save,status,delete',
			'room_key' => 'required|string',
			'id' => 'string',
			'order' => 'string',
			'status' => 'in open,progress,done,cancelled',
			'lang' => 'string'
		];

		$ret = $this->validateInput($fields);

		if (!$ret) {
			$this->respond(['error' => ['messages' => array_column(get_and_clear_messages(), 'message')]]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN;
	}

	protected function doAction(): void {
		$lang = $this->getInput('lang', 'es');
		I18n::setLanguage(['es' => I18n::LANG_ES, 'pt' => I18n::LANG_PT, 'en' => I18n::LANG_EN][$lang] ?? I18n::LANG_AUTO);

		$loaded = Config::load();

		if ($loaded === null) {
			$this->fail(I18n::t('El módulo no está habilitado.'));

			return;
		}

		[$moduleid, $config] = $loaded;
		$room = Layout::roomKey($this->getInput('room_key') === Layout::DEFAULT_ROOM ? '' : $this->getInput('room_key'));

		if (!Config::canEditRoom($config, $room)) {
			$this->fail(I18n::t('No tienes permiso para editar esta sala.'));

			return;
		}

		$op = $this->getInput('op');
		$id = $this->getInput('id', '');
		$current = $id !== '' ? WorkOrders::find($config, $room, $id) : null;

		if ($id !== '' && $current === null) {
			$this->fail(I18n::t('La orden ya no existe. Recarga el widget.'));

			return;
		}

		if ($op === 'delete') {
			$current['status'] = 'cancelled';
			$error = WorkOrders::syncMaintenance($current, $room);
			WorkOrders::remove($config, $room, $id);
			$verb = I18n::t('Orden borrada');
		}
		elseif ($op === 'status') {
			$status = $this->getInput('status', 'open');

			if (in_array($current['status'], ['done', 'cancelled'], true)) {
				$this->fail(I18n::t('La orden ya está cerrada.'));

				return;
			}

			$current['status'] = $status;
			$current['updated'] = time();

			if (in_array($status, ['done', 'cancelled'], true)) {
				$current['closed'] = time();
			}

			$error = WorkOrders::syncMaintenance($current, $room);
			$current = WorkOrders::put($config, $room, $current);
			$verb = [
				'open' => I18n::t('Orden reabierta'),
				'progress' => I18n::t('Orden en curso'),
				'done' => I18n::t('Orden terminada'),
				'cancelled' => I18n::t('Orden cancelada')
			][$status];
		}
		else {
			if ($current !== null && in_array($current['status'], ['done', 'cancelled'], true)) {
				$this->fail(I18n::t('La orden ya está cerrada.'));

				return;
			}

			$input = json_decode($this->getInput('order', ''), true);
			[$order, $error] = WorkOrders::normalize(is_array($input) ? $input : [], $current);

			if ($order === null) {
				$this->fail($error);

				return;
			}

			// Solo hosts que el usuario puede ver en Zabbix.
			if ($order['hostids']) {
				$order['hostids'] = array_map('strval', array_column(API::Host()->get([
					'output' => ['hostid'],
					'hostids' => $order['hostids']
				]), 'hostid'));
			}

			// Primero se guarda la orden para tener su número (va en el nombre del mantenimiento).
			$order = WorkOrders::put($config, $room, $order);
			$error = WorkOrders::syncMaintenance($order, $room);
			$order = WorkOrders::put($config, $room, $order);
			$current = $order;
			$verb = $id === '' ? I18n::t('Orden creada') : I18n::t('Orden editada');
		}

		$save_error = Config::save($moduleid, $config, null, '', $current ? WorkOrders::auditText($verb, $current, $room) : '');

		if ($save_error !== null) {
			$this->fail($save_error);

			return;
		}

		$this->respond([
			'success' => true,
			'orders' => WorkOrders::list($config, $room),
			'order' => $op === 'delete' ? null : $current,
			// La orden se guarda igual; si Zabbix rechazó el mantenimiento se avisa aparte.
			'warning' => $error !== null ? I18n::t('La orden se guardó, pero Zabbix no aceptó el periodo de mantenimiento:').' '.$error : '',
			'message' => $verb.'.'
		]);
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
