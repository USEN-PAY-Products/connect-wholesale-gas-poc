### `wholesaler_invoices`

| id | wholesaler_user_id | wholesaler_id | wholesaler_invoice_date | wholesaler_total_amount | wholesaler_subtotal_amount | wholesaler_tax_amount | wholesaler_total_ex_tax_10 | wholesaler_consumption_tax_10 | wholesaler_total_ex_tax_8 | wholesaler_consumption_tax_8 | wholesaler_fee_rate | invoice_fee_amount | payment_amount | wholesaler_invoice_csv_url | created_by | created_at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| aa6e7c61-4bb2-497f-8fe4-51a543025070 | 00000000-0000-0000-0000-000000000001 | 1 | 2026-05-22 | 54200 | 50000 | 4200 | 10000 | 1000 | 40000 | 3200 | 5.0 | 2710 | 51490 | https://drive.google.com/file/d/1Z_iFOlQbRsiNQ8Y0kg4WRhWvmlOJMopP/view?usp=drivesdk | 00000000-0000-0000-0000-000000000001 | 2026-05-22 05:14:03 UTC |

### `store_invoices`

| id | wholesaler_invoice_id | wholesaler_id | backoffice_review_status | mall_code | total_amount | subtotal_amount | tax_amount | total_ex_tax_10per | consumption_tax_10per | total_ex_tax_8per | consumption_tax_8per | is_latest | final_updated_by | created_at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 7591a6f4-37a0-4159-ac45-8def204aea58 | aa6e7c61-4bb2-497f-8fe4-51a543025070 | 1 | PENDING_REVIEW | MALL-002 | 11000 | 10000 | 1000 | 10000 | 1000 | 0 | 0 | 1 | 00000000-0000-0000-0000-000000000001 | 2026-05-22T14:14:03 |
| ae5118b1-5d78-4814-b4df-5155b40421be | aa6e7c61-4bb2-497f-8fe4-51a543025070 | 1 | PENDING_REVIEW | MALL-001 | 43200 | 40000 | 3200 | 0 | 0 | 40000 | 3200 | 1 | 00000000-0000-0000-0000-000000000001 | 2026-05-22T14:14:03 |

### `invoice_lines`

| id | invoice_item_row | store_invoice_id | transaction_date | item_name | quantity | unit_price | tax_category | line_amount_excluding_tax | line_tax_amount | line_note |
|---|---|---|---|---|---|---|---|---|---|---|
| 31d7ea5a-4ab8-4711-b279-384d9234122d | 1 | ae5118b1-5d78-4814-b4df-5155b40421be | 2026-04-13 | 〇〇県産 牛肉 5kg | 20 | 2000 | 8 | 40000 | 3200 | 備考です |
| bf08e899-b747-4583-8c3f-59dece1d23d0 | 1 | 7591a6f4-37a0-4159-ac45-8def204aea58 | 2026-04-14 | 〇〇県産 牛肉 5kg | 10 | 1000 | 10 | 10000 | 1000 | |
	

### テストデータ（事前投入）

#### `wholesaler_merchants`

| id | wholesaler_id | customer_code | mall_code | invoice_limit | registration_at | deleted_at |
|---|---|---|---|---|---|---|
| 99bd4a1c-1847-455b-b3b4-7c6438bb9cf0 | 1 | C001 | MALL-001 | 9999999 | 2026-05-22 | |
| 567bd884-986b-430e-b7ba-661fb72f0023 | 1 | C002 | MALL-002 | 9999999 | 2026-05-22 | |

#### `store`

| mall_code | store_name | store_status | store_active_date | created_at | updated_at |
|---|---|---|---|---|---|
| MALL-001 | テスト加盟店1 | entry | 2026-05-22 | 2026-05-22 05:13:03 UTC | 2026-05-22 05:13:03 UTC |
| MALL-002 | テスト加盟店2 | entry | 2026-05-22 | 2026-05-22 05:13:03 UTC | 2026-05-22 05:13:03 UTC |


INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_user`
  (id, wholesaler_id, wholesaler_email, registration_at, deleted_at)
VALUES
  ('00000000-0000-0000-0000-000000000010', 3, 's-sobu@unext-hd.jp', '2026-05-22', NULL);

INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_user`
  (id, wholesaler_id, wholesaler_email, registration_at, deleted_at)
VALUES
  ('00000000-0000-0000-0000-000000000011', 4, 'g-nakada@unext-hd.jp', '2026-05-26', NULL);

INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_user`
  (id, wholesaler_id, wholesaler_email, registration_at, deleted_at)
VALUES
  ('00000000-0000-0000-0000-000000000012', 4, 'kt-aoki@unext-hd.jp', '2026-05-26', NULL);

INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_user`
  (id, wholesaler_id, wholesaler_email, registration_at, deleted_at)
VALUES
  ('00000000-0000-0000-0000-000000000013', 3, 'mk-hanaki@unext-hd.jp', '2026-05-26', NULL);

INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_user`
  (id, wholesaler_id, wholesaler_email, registration_at, deleted_at)
VALUES
  ('00000000-0000-0000-0000-000000000014', 3, 'yj-mori@unext-hd.jp', '2026-05-26', NULL);

INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_merchants`
  (id, wholesaler_id, customer_code, mall_code, invoice_limit, registration_at, deleted_at)
VALUES
  (GENERATE_UUID(), 4, 'C003', 'MK01', 9999999, '2026-06-01', NULL);
  INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_merchants`
  (id, wholesaler_id, customer_code, mall_code, invoice_limit, registration_at, deleted_at)
VALUES
  (GENERATE_UUID(), 4, 'C004', 'MK02', 9999999, '2026-06-01', NULL);

INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_merchants`
  (id, wholesaler_id, customer_code, mall_code, invoice_limit, registration_at, deleted_at)
VALUES
  (GENERATE_UUID(), 4, 'C005', 'MK03', 9999999, '2026-06-01', NULL);
INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_merchants`
  (id, wholesaler_id, customer_code, mall_code, invoice_limit, registration_at, deleted_at)
VALUES
  (GENERATE_UUID(), 4, 'C001', 'MK04', 9999999, '2026-06-01', NULL);
INSERT INTO `usenpay-connect-dev.connect_db.wholesaler_merchants`
  (id, wholesaler_id, customer_code, mall_code, invoice_limit, registration_at, deleted_at)
VALUES
  (GENERATE_UUID(), 4, 'C002', 'MK05', 9999999, '2026-06-01', NULL);


UPDATE `usenpay-connect-dev.connect_db.store_invoices`
SET 
  backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED', 
  invoice_status = 'DISPUTED'
WHERE id = '8a986104-7c8c-4348-991b-393e13279ee0';
UPDATE `usenpay-connect-dev.connect_db.store_invoices`
SET 
  backoffice_review_status = 'RETURNED', 
  invoice_status = NULL
WHERE id = '989365e2-bb14-4dad-ad02-77c318cc359e';
UPDATE `usenpay-connect-dev.connect_db.store_invoices`
SET 
  backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED', 
  invoice_status = 'PENDING_CONFIRMATION'
WHERE id = '6642769f-7b3e-4f32-864e-e19226856ac1';
UPDATE `usenpay-connect-dev.connect_db.store_invoices`
SET 
  backoffice_review_status = 'MERCHANT_CONFIRMATION_REQUESTED', 
  invoice_status = 'APPROVED'
WHERE id = '7740773d-a778-45a2-94ec-bee32b2b529b';



id	wholesaler_invoice_id	wholesaler_id	invoice_number_id	invoice_number	backoffice_review_status	invoice_status	mall_code	store_invoice_date	total_amount	subtotal_amount	tax_amount	standard_tax_target_amount	standard_tax_amount	reduced_tax_target_amount	reduced_tax_amount	non_taxable_amount	backoffice_handover	wholesaler_handover	store_disputed_reason	wholesaler_remark	backoffice_remark	operation_updated_by	operation_update_at	is_latest	final_updated_by	created_at	updated_at
8a986104-7c8c-4348-991b-393e13279ee0	e122e8c3-e8d4-4300-8216-3d61e2eec26a	1			PENDING_REVIEW		MK05		65216	59750	5466	34340	3434	25410	2032	0				これで問題ないですか？				true	00000000-0000-0000-0000-000000000002	2026-05-27 06:05:27.912000 UTC	
989365e2-bb14-4dad-ad02-77c318cc359e	e122e8c3-e8d4-4300-8216-3d61e2eec26a	1			PENDING_REVIEW		MK03		115892	106164	9728	61800	6180	44364	3548	0								true	00000000-0000-0000-0000-000000000002	2026-05-27 06:05:27.912000 UTC	
6642769f-7b3e-4f32-864e-e19226856ac1	e122e8c3-e8d4-4300-8216-3d61e2eec26a	1			PENDING_REVIEW		MK01		84377	77242	7135	47800	4780	29442	2355	0								true	00000000-0000-0000-0000-000000000002	2026-05-27 06:05:27.912000 UTC	
7740773d-a778-45a2-94ec-bee32b2b529b	e122e8c3-e8d4-4300-8216-3d61e2eec26a	1			PENDING_REVIEW		MK02		69357	63520	5837	37800	3780	25720	2057	0				サンプルですー				true	00000000-0000-0000-0000-000000000002	2026-05-27 06:05:27.912000 UTC	
5b35520e-466a-4f3a-8c82-fbc49974a94b	e122e8c3-e8d4-4300-8216-3d61e2eec26a	1			PENDING_REVIEW		MK04		69432	63613	5819	36500	3650	27113	2169	0				青山フーズさんよろしくです				true	00000000-0000-0000-0000-000000000002	2026-05-27 06:05:27.912000 UTC	





id	wholesaler_user_id	wholesaler_id	wholesaler_invoice_date	wholesaler_total_amount	wholesaler_subtotal_amount	wholesaler_tax_amount	wholesaler_standard_tax_target_amount	wholesaler_standard_tax_amount	wholesaler_reduced_tax_target_amount	wholesaler_reduced_tax_amount	wholesaler_non_taxable_amount	wholesaler_fee_rate	invoice_fee_amount	payment_amount	handover_matter	wholesaler_invoice_id	backoffice_note	wholesaler_invoice_csv_url	operation_updated_by	operation_update_at	final_updated_by	created_at	updated_at
01970f7a-7f10-7000-8005-000000000104	00000000-0000-0000-0000-000000000007	1	2026-05-05	55000	50000	5000	50000	5000	0	0	0	4.2	2310	52690				gs://example-bucket/wholesaler_invoice_20260505.csv			system	2026-03-31 15:00:00.000000 UTC	
e122e8c3-e8d4-4300-8216-3d61e2eec26a	00000000-0000-0000-0000-000000000002	1	2026-05-27	404274	370289	33985	218240	21824	152049	12161	0	5	20213	384061	コメントテスト〜		メモメモ	https://drive.google.com/file/d/14KgL9VWLXXZDOazreqVrescbGOP6yd9h/view?usp=drivesdk	kh-ito@unext-hd.jp	2026-05-28	kh-ito@unext-hd.jp	2026-03-31 15:00:00.000000 UTC	2026-05-28 07:25:47.440137 UTC
01970f7a-7f10-7000-8005-000000000204	01970f7a-7f10-7000-8000-000000000102	2	2026-06-18	66000	60000	6000	60000	6000	0	0	0	4.2	2772	63228				gs://example-bucket/wholesaler_invoice_20260618_wh2.csv			system	2026-06-17 15:00:00.000000 UTC	
9d61a964-9d05-4ec4-9c64-548d91c5fc23	00000000-0000-0000-0000-000000000002	1	2026-05-26	4419	4092	327	0	0	4092	327	0	5	220	4199				https://drive.google.com/file/d/1S6RGvz9cD3MNCO5Ec-w7vpTNkHFZdemy/view?usp=drivesdk				2026-03-31 15:00:00.000000 UTC	
01970f7a-7f10-7000-8005-000000000101	01970f7a-7f10-7000-8000-000000000102	2	2026-05-26	0	0	0	0	0	0	0	0	0	0	0				gs://example-bucket/wholesaler_invoice_20260526.csv				2026-03-31 15:00:00.000000 UTC	
01970f7a-7f10-7000-8005-000000000102	01970f7a-7f10-7000-8000-000000000102	2	2026-05-26	110000	100000	10000	100000	10000	0	0	0	4.2	4620	105380				gs://example-bucket/wholesaler_invoice_20260526.csv			system	2026-03-31 15:00:00.000000 UTC	
01970f7a-7f10-7000-8005-000000000203	01970f7a-7f10-7000-8000-000000000102	2	2026-06-12	88000	80000	8000	80000	8000	0	0	0	4.2	3696	84304	あああ		テスト	gs://example-bucket/wholesaler_invoice_20260612_wh2.csv	kh-ito@unext-hd.jp	2026-05-28	kh-ito@unext-hd.jp	2026-06-11 15:00:00.000000 UTC	2026-05-28 08:35:39.697200 UTC
01970f7a-7f10-7000-8005-000000000207	01970f7a-7f10-7000-8000-000000000102	2	2026-07-05	99000	90000	9000	90000	9000	0	0	0	4.2	4158	94842				gs://example-bucket/wholesaler_invoice_20260705_wh2.csv			system	2026-07-04 15:00:00.000000 UTC	
01970f7a-7f10-7000-8005-000000000206	01970f7a-7f10-7000-8000-000000000102	2	2026-06-30	121000	110000	11000	110000	11000	0	0	0	4.2	5082	115918				gs://example-bucket/wholesaler_invoice_20260630_wh2.csv			system	2026-06-29 15:00:00.000000 UTC	
01970f7a-7f10-7000-8005-000000000205	01970f7a-7f10-7000-8000-000000000102	2	2026-06-25	143000	130000	13000	130000	13000	0	0	0	4.2	6006	136994	あああいいい		ううう	gs://example-bucket/wholesaler_invoice_20260625_wh2.csv	kh-ito@unext-hd.jp	2026-05-28	kh-ito@unext-hd.jp	2026-06-24 15:00:00.000000 UTC	2026-05-28 09:49:57.106198 UTC
01970f7a-7f10-7000-8005-000000000103	00000000-0000-0000-0000-000000000007	1	2026-06-02	110000	100000	10000	100000	10000	0	0	0	4.2	4620	105380				gs://example-bucket/wholesaler_invoice_20260602.csv			system	2026-06-01 15:00:00.000000 UTC	