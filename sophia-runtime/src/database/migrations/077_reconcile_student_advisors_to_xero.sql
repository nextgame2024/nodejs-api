-- Audit of all 1,068 visible students on 2026-10-19 found 159 corrections:
-- 154 different advisors and 5 missing assignments. 907 already match;
-- 2 have no Advisor Xero value and are intentionally untouched.
-- Source of truth: the Advisor Xero column in the Students register, including
-- its stored-case-label priority over the newest linked invoice's advisor.
-- Preserve Xero fields and case advisor login/access grants. Update only the
-- audited student IDs when both their assignment and source still match the
-- read-only snapshot; later edits are not overwritten. Safe to rerun.
WITH audited(student_id, student_reference, old_advisor_id,
             target_advisor_id, target_code, expected_xero_label) AS (
  VALUES
    ('c0266221-9cd7-44d1-b7ea-42a123513e7c'::uuid, 'STD-1002', NULL::uuid, 'a100a29e-d32f-483c-8651-d403f7be5392'::uuid, 'S69', 'S69 Pedro Munoz'),
    ('b4bf3aaf-6502-47d3-bab6-9c3b02e597e2'::uuid, 'STD-1011', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('c037e9ed-acc0-44fc-8758-b147f47c1756'::uuid, 'STD-1023', NULL::uuid, 'a100a29e-d32f-483c-8651-d403f7be5392'::uuid, 'S69', 'S69 Pedro Munoz'),
    ('665f8840-95e5-45ea-bb52-a96badfdd6e0'::uuid, 'STD-1024', NULL::uuid, 'a100a29e-d32f-483c-8651-d403f7be5392'::uuid, 'S69', 'S69 Pedro Munoz'),
    ('19d8c19f-980c-481a-a9d5-526c27c98a78'::uuid, 'STD-1029', NULL::uuid, 'a100a29e-d32f-483c-8651-d403f7be5392'::uuid, 'S69', 'S69 Pedro Munoz'),
    ('c2158dc7-7619-49fe-9614-d634b41b69da'::uuid, 'STD-1035', NULL::uuid, 'a100a29e-d32f-483c-8651-d403f7be5392'::uuid, 'S69', 'S69 Pedro Munoz'),
    ('377bca78-cdc2-43fa-8e36-f8a29e6a170c'::uuid, 'STD-1046', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('d7bd7fe5-2676-4c6e-a204-34da10c7f27e'::uuid, 'STD-1049', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'dc55a914-619d-4baa-9f56-3712ecd61507'::uuid, 'C60', 'C60 Hernan Sierra'),
    ('21caf409-3917-4ed0-b17e-145d46ac8a21'::uuid, 'STD-105', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('fef3d28c-9442-40ef-b471-acab4ecc7ee7'::uuid, 'STD-1065', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('bed11c72-5cd5-4f14-a0c7-199d503e7798'::uuid, 'STD-1067', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('a1e6ac5f-3341-49bb-84e6-4c724233b73a'::uuid, 'STD-111', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('f0d1d93e-88ac-44a6-99c9-8a38d4f3e3b4'::uuid, 'STD-113', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('22ca8601-adaf-4ab3-ac8a-2e1dba4fda47'::uuid, 'STD-135', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('d7ada1c3-3164-492e-8e7f-77b1b72ba404'::uuid, 'STD-143', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('8383a6c5-94cb-4a6e-a74a-4be61aeb4543'::uuid, 'STD-144', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('f92626ab-afdc-449a-8296-816a88c3eada'::uuid, 'STD-168', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('bd9d0e45-1ae6-4f30-b231-a343f4c36fd4'::uuid, 'STD-191', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('25fba0df-1a6e-45a2-b96e-935498383351'::uuid, 'STD-215', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('39a4212f-a634-44ff-bbdd-597c6496fa9e'::uuid, 'STD-217', 'a0c709bc-8d2f-4a9c-9355-89c285078997'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('4c8bcdc0-57a5-4834-bcdc-719606c42dac'::uuid, 'STD-219', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('587075d4-36d1-4965-8dc1-728a0fbd7b58'::uuid, 'STD-22', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e7aa20ca-0099-4b3b-8deb-4b6652e182bd'::uuid, 'C31', 'C31 Liliana Gallego'),
    ('0e95ec1a-6288-44a7-9dcf-7739a2438dae'::uuid, 'STD-23', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'ac2dd884-a86d-4633-b8e4-8e1ed97b0c71'::uuid, 'C30', 'C30 Pablo Arias'),
    ('0c55ed8e-686b-4bf6-9310-f696c1eb3837'::uuid, 'STD-238', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('29872d58-fdba-4d59-b172-fabb984dc7b2'::uuid, 'STD-239', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('90e759b3-61f2-4bc5-b946-4273599ce674'::uuid, 'STD-252', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'a100a29e-d32f-483c-8651-d403f7be5392'::uuid, 'S69', 'S69 Pedro Munoz'),
    ('9d5edaec-6d4e-4ef9-bee4-e63f663bcf7e'::uuid, 'STD-254', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('cebfcee3-e2c5-42e8-b51c-ce38ffd7bdd1'::uuid, 'STD-255', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'dc55a914-619d-4baa-9f56-3712ecd61507'::uuid, 'C60', 'C60 Hernan Sierra'),
    ('7d1c325b-49f0-48cd-94f5-bcd366c989d4'::uuid, 'STD-258', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('4b0c341e-e624-49d8-adc7-2dcff1864f3c'::uuid, 'STD-260', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'ac2dd884-a86d-4633-b8e4-8e1ed97b0c71'::uuid, 'C30', 'C30 Pablo Arias'),
    ('d682cffe-73b5-42d7-a1e9-2cb01968d182'::uuid, 'STD-271', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('db0eeb71-5cf4-448d-bdac-b25dc98342b2'::uuid, 'STD-275', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('c5e00e69-4f71-4684-82d5-8036d4890943'::uuid, 'STD-282', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('23bc2524-fb54-405e-9419-e0abffa21d42'::uuid, 'STD-29', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('17e13015-108b-40d4-9857-2d346066b65f'::uuid, 'STD-295', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('051dd948-0f64-4896-a64b-91ced5621263'::uuid, 'STD-30', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('55aa95fa-20fe-40cb-b532-52e3b5b4fe2b'::uuid, 'STD-304', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('5d2ef7cf-4d15-4105-a329-ebd319dc2d24'::uuid, 'STD-312', 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('ab3795b7-2811-495c-a2d7-2d7baacd4507'::uuid, 'STD-320', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('bfdfb6b2-dbc1-4508-9be4-4b317468d678'::uuid, 'STD-328', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('65023ce3-9ea7-4264-b027-45f66077ba50'::uuid, 'STD-346', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('420adce6-81d2-4ad3-beb2-a1664f94a96b'::uuid, 'STD-349', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('d14a7ac2-1fa0-43af-8146-e97636a6dd38'::uuid, 'STD-362', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('3e115117-c3aa-4605-a468-0a99fa1da5ab'::uuid, 'STD-373', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('c82bf86b-3a40-41e0-9eaf-4703de01522e'::uuid, 'STD-374', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('59723b34-9ca0-400f-95eb-a734686c3646'::uuid, 'STD-375', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('33019461-7a16-4932-9516-0f15195a5a40'::uuid, 'STD-376', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('f0de1e5d-976d-411d-b624-3fd8b542944c'::uuid, 'STD-384', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('ebec4431-4ba5-4804-9a4d-4e44da66290a'::uuid, 'STD-392', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('5d4e9ece-027e-44d4-bfc9-634988592a90'::uuid, 'STD-408', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('1b110005-e1eb-40ff-af54-a23cfd85940e'::uuid, 'STD-413', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'ac2dd884-a86d-4633-b8e4-8e1ed97b0c71'::uuid, 'C30', 'C30 Pablo Arias'),
    ('bca55028-64ca-4819-a3dd-f6cbaf497aa8'::uuid, 'STD-426', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('86c9ceee-8c81-49f5-9f54-f0f68d02f0cf'::uuid, 'STD-429', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('793a46e0-b8c8-4041-b6ce-47245b687ced'::uuid, 'STD-432', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('a6b68733-8731-4701-a081-8c0d30204723'::uuid, 'STD-434', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'dc55a914-619d-4baa-9f56-3712ecd61507'::uuid, 'C60', 'C60 Hernan Sierra'),
    ('391a00c7-fcc7-458e-9a7b-f162bdb04438'::uuid, 'STD-44', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('1fb79154-1822-4d47-9e5c-55fe87f74ebd'::uuid, 'STD-440', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('49cae225-2e66-4bc8-a8ee-ccaba58c74a3'::uuid, 'STD-448', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('99b37616-d82b-4b02-a5f8-4933ac24a653'::uuid, 'STD-45', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('3231b0fb-9149-4896-a17e-97c031db6365'::uuid, 'STD-451', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('726fbebb-4ba6-48d5-8422-145af3e136c6'::uuid, 'STD-454', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('6eef3365-5d56-4afa-a26b-55f754aaba4b'::uuid, 'STD-457', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('293287cd-6c71-4ada-b7d1-ffe9276cbc75'::uuid, 'STD-462', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('b98bf553-3d5a-4a0b-8834-8f3bc67aaec0'::uuid, 'STD-471', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('727e29b8-85ff-4b4c-b44d-c109753a8e40'::uuid, 'STD-477', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('8113b6b3-70d6-4858-ba49-2ea9d3b270d6'::uuid, 'STD-478', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('ea04a2a9-0ea5-45f4-b7d3-f492a8d0df32'::uuid, 'STD-481', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('0c550fc1-3c43-4e94-9031-836d7fae1824'::uuid, 'STD-494', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('fc6ff85b-1e4a-4d66-a3e2-99e34408e482'::uuid, 'STD-495', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('b122219c-a9dc-4658-b6f4-bfb4f019aa95'::uuid, 'STD-496', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('3a2f72a8-8689-4de7-882f-db0ae127b5fe'::uuid, 'STD-506', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('da9d51c8-14e5-4412-9639-f22fb621acd3'::uuid, 'STD-511', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8051fe14-c27f-46b8-80ee-b682c5204043'::uuid, 'C82', 'C82 Cindy Ortiz'),
    ('9fab204d-f370-492e-9ac0-54736745865f'::uuid, 'STD-525', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('a4e4ae25-960e-457c-b3c4-19dc54a3e657'::uuid, 'STD-53', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('d011da98-28ff-44f8-8966-709969a63ee4'::uuid, 'STD-542', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('6575ebe0-5803-486f-8a3c-62d3b5a4cff4'::uuid, 'STD-544', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('54dff01d-90a0-4db0-8131-0408196af2fa'::uuid, 'STD-545', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('e59b8b97-5ea1-42dd-9b70-294951f6f67f'::uuid, 'STD-555', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('b2379c47-eebd-4f79-8387-dfe247b7740e'::uuid, 'STD-562', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('394880dd-a1ed-4c46-8349-b878400983ae'::uuid, 'STD-567', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'dc55a914-619d-4baa-9f56-3712ecd61507'::uuid, 'C60', 'C60 Hernan Sierra'),
    ('45ead92e-f995-499b-a38b-3c3924a340da'::uuid, 'STD-574', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('3fd80216-8edd-4b8b-a0d3-399c8b3f1c0a'::uuid, 'STD-575', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('ef722fe2-e01c-43b7-abbb-9e12ca1ebf12'::uuid, 'STD-576', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('895014de-8376-434a-93e6-a5a00706f240'::uuid, 'STD-578', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('ebc9c467-4d70-4941-b81d-dce92e0c417b'::uuid, 'STD-586', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('06391bfb-f4c2-43fe-855d-5627467d9ad7'::uuid, 'STD-589', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('9064c0c1-ad6d-4463-b36e-6a66ec9e7e1d'::uuid, 'STD-590', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('c26fa708-df38-413f-9dbd-260f3dba9a01'::uuid, 'STD-595', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('38d0c41a-13ea-4db8-ae25-476556d195b6'::uuid, 'STD-6', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('246b1ee4-15ab-40f7-ba22-14e196567f28'::uuid, 'STD-601', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('cd09818f-6d6a-4ec3-a45d-4898485c5448'::uuid, 'STD-603', 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('bdfb8711-23a3-413e-9696-a72141019767'::uuid, 'STD-606', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('73cd94ee-c40f-4d7a-b5b8-819d3f9d6a01'::uuid, 'STD-608', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'e7aa20ca-0099-4b3b-8deb-4b6652e182bd'::uuid, 'C31', 'C31 Liliana Gallego'),
    ('1ca57595-75fa-4499-af04-58f7d1af2070'::uuid, 'STD-612', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('0bdbc21e-aa74-4aa2-be54-0db89cf6aa13'::uuid, 'STD-622', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('e6765075-6038-4d90-b95b-d4627cdfdc7f'::uuid, 'STD-629', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'ac2dd884-a86d-4633-b8e4-8e1ed97b0c71'::uuid, 'C30', 'C30 Pablo Arias'),
    ('ad5b081f-f4e5-4d44-b777-c763d741e78b'::uuid, 'STD-630', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8051fe14-c27f-46b8-80ee-b682c5204043'::uuid, 'C82', 'C82 Cindy Ortiz'),
    ('798ac17a-75e5-441d-b8a1-3978065d0c13'::uuid, 'STD-634', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('c952dcef-bd49-4958-8c6f-7a3daf122be8'::uuid, 'STD-642', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('2da42c31-0b3e-4f6c-b3ed-0b5e15d871ad'::uuid, 'STD-659', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('79dccc16-202b-4a80-9a53-d5c85ea001ab'::uuid, 'STD-66', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('967b2f20-e552-43ff-88c6-8bf70e364e8c'::uuid, 'STD-665', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('1cbcf5c6-eac8-4539-bf75-623c495e82bc'::uuid, 'STD-671', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('f63eb0cc-de87-4ee9-bd8a-8cdaf40da630'::uuid, 'STD-677', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('118e15a5-0151-4e6c-a664-66e34e01f19b'::uuid, 'STD-687', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('00d52994-de6f-459f-acbc-7e5f01de981c'::uuid, 'STD-689', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('3deeaf19-1f4d-4a4f-958f-52e73527669b'::uuid, 'STD-7', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('8dd19731-453c-4ec7-9bdc-2bae2da87e7e'::uuid, 'STD-700', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('15f8690d-5125-4f7c-9d02-992b42655115'::uuid, 'STD-704', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('055f63eb-cff8-40bf-9de1-eda8d7fa4fb1'::uuid, 'STD-707', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('9f13ed43-c411-4d48-8ff8-4c055865a792'::uuid, 'STD-719', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'dc55a914-619d-4baa-9f56-3712ecd61507'::uuid, 'C60', 'C60 Hernan Sierra'),
    ('9c6e74e7-80e9-4f5c-a985-362e9af7d5dc'::uuid, 'STD-72', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('b5fbeecd-ede7-4f03-b460-c82474d437d4'::uuid, 'STD-737', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('a0e7dffb-9ac0-4e4a-86d7-6dfd7c238aca'::uuid, 'STD-745', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('0fdd92d5-628c-4087-a79d-0d49091a1888'::uuid, 'STD-750', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('025e5737-024e-4ab4-9094-f8a46b288fd2'::uuid, 'STD-751', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('93f989cf-7110-45c4-b3c3-38245c54e774'::uuid, 'STD-755', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('32480e63-5732-4083-950e-eed46124bf48'::uuid, 'STD-758', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('3d687bfa-4a0d-4d53-856f-b0a4b466817c'::uuid, 'STD-76', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('4053cdff-8be5-4e7b-8d4a-9a9d274b3d2f'::uuid, 'STD-760', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('089ebcdf-c785-45b9-a8f6-0b4e4a7cb166'::uuid, 'STD-770', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('b31b2d2c-5ac5-4fa9-bd55-d093eb10985b'::uuid, 'STD-771', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'e7aa20ca-0099-4b3b-8deb-4b6652e182bd'::uuid, 'C31', 'C31 Liliana Gallego'),
    ('460221cf-8f7f-411d-b926-e25852b50270'::uuid, 'STD-78', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('ee924c35-6d38-4d1f-8f0a-5ef9aa0a83d0'::uuid, 'STD-781', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('8e089f3d-4a42-45df-b75a-460257bcfd67'::uuid, 'STD-786', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('1e2c2cba-2ac5-4921-ae36-1f46bb42b27a'::uuid, 'STD-798', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('c9df6c1d-0cc1-470e-98f5-4c28f59893c3'::uuid, 'STD-815', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'ac2dd884-a86d-4633-b8e4-8e1ed97b0c71'::uuid, 'C30', 'C30 Pablo Arias'),
    ('0d723a2a-e635-470f-bbc3-8ca606e3af69'::uuid, 'STD-817', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8051fe14-c27f-46b8-80ee-b682c5204043'::uuid, 'C82', 'C82 Cindy Ortiz'),
    ('769d72a4-6683-4581-9720-7de1fa856a95'::uuid, 'STD-825', 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('3f6e7e7a-8aa0-4f84-95b8-923c9976788c'::uuid, 'STD-827', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('d09b1d2b-81d1-4078-95bf-cbd848670383'::uuid, 'STD-83', 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('7d90cd35-97fc-414e-a544-abd1192feffc'::uuid, 'STD-830', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('aab2a8ee-525c-4a3e-9dab-78b08d46522d'::uuid, 'STD-837', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('c560c0c2-3bdd-43e7-b93c-52678af5697c'::uuid, 'STD-840', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'ca10923c-e538-486d-bbc2-bee0626e41ac'::uuid, 'C81', 'C81 Juan Jose Giraldo'),
    ('a3951e0b-ff25-4b84-89e8-2f43a9f41570'::uuid, 'STD-841', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('1d564f63-3fe9-47af-8bfe-1d7fa522d5e3'::uuid, 'STD-844', 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('b769572b-32b6-42ff-b753-9d9f05a7bf47'::uuid, 'STD-848', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('a3e91d1e-f95f-40ae-ab41-a10164fc7885'::uuid, 'STD-849', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8051fe14-c27f-46b8-80ee-b682c5204043'::uuid, 'C82', 'C82 Cindy Ortiz'),
    ('a514a1a1-318d-426f-8e55-16e7c8361b53'::uuid, 'STD-862', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('1e755d20-00f7-486d-9397-0b62a82aacd8'::uuid, 'STD-869', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'S15', 'S15 Paulina Aguillon'),
    ('4a832c5b-dd9b-4c1f-a6fe-57840fb31c88'::uuid, 'STD-876', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('b410917a-173a-493f-8064-c842db03ce0d'::uuid, 'STD-881', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'c15261ad-9a85-4008-82e4-8ca02f1bb3a5'::uuid, 'S10', 'S10 Julieta Mesa'),
    ('e55205e8-facb-4aa8-95aa-d4a7c031af75'::uuid, 'STD-882', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('01be3547-fb9c-4317-b094-2ec235702564'::uuid, 'STD-883', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('fffab7bd-32e9-46b7-89dd-0e9a0b3f2bff'::uuid, 'STD-884', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '8559f56b-6b80-4dbe-992f-8b5a7e630431'::uuid, 'C20', 'C20 Rodrigo Galvis'),
    ('510676e5-889b-49a2-952f-7fbd14589e59'::uuid, 'STD-887', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('e8149baa-de1f-4bda-b3a0-0ef75bc8ce41'::uuid, 'STD-888', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('5c8bce10-7f5f-4227-bd46-6f8a77f76855'::uuid, 'STD-891', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('7ce521cf-ac35-4f08-8c90-891d787f4f89'::uuid, 'STD-899', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('d4cbe55d-9a3c-4c6a-87b0-b51f9e8b1c63'::uuid, 'STD-903', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, 'S80', 'S80 Daniela Yepez'),
    ('5f16fc2c-02e5-40d1-bf75-46a407bf4bce'::uuid, 'STD-904', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('e023be1d-bccb-4807-b3d9-39ddc6663b7f'::uuid, 'STD-906', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica'),
    ('99d00bfa-5b67-4bbe-81fc-f4ab657bbdc7'::uuid, 'STD-909', 'e284f8f8-ba5e-4e87-8585-6d9c037f9570'::uuid, '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'O10', 'O10 Open for Australia'),
    ('27e8b86c-dc7d-4f75-9183-3b9f00f30915'::uuid, 'STD-910', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('52035b67-0337-4f17-b27a-f68070156780'::uuid, 'STD-94', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '314a7b80-8382-4801-aafd-b722d2a3a78d'::uuid, 'S30', 'S30 Melisa Lopez'),
    ('ba2cfe68-fa0c-47c6-9e30-4735c6776230'::uuid, 'STD-955', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'b24372e6-f0f6-4d9d-8dca-7a2be2b26d05'::uuid, 'S11', 'S11 Andres Hernandez'),
    ('97e858bf-448f-4e55-8dce-2fd8f8741289'::uuid, 'STD-97', '0c0ec0ff-0ae2-47a0-93b8-13daa4700f75'::uuid, 'e7aa20ca-0099-4b3b-8deb-4b6652e182bd'::uuid, 'C31', 'C31 Liliana Gallego'),
    ('8d174c99-a843-4476-b4fb-0656533aeb11'::uuid, 'STD-976', 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, '2d3f59c9-fe5d-4c43-a398-9a73ed27ddbb'::uuid, 'C70', 'C70 Angela White'),
    ('bd3f176d-1d38-47d0-ba96-b9a5c51adadd'::uuid, 'STD-987', '0255071f-6034-4b2f-9a67-2f711669f1e7'::uuid, 'eb0518bd-8ebb-4146-89ae-7fea4667b0b6'::uuid, 'C90', 'C90 Yuliet Chica')
), current_source AS (
  SELECT audited.*, student.customer_id,
         coalesce(nullif(btrim(current_case.advisor_name), ''),
                  case_invoice.advisor_name, student_invoice.advisor_name) AS advisor_xero_name
    FROM audited
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_students student
      ON student.student_id = audited.student_id
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers customer
      ON customer.customer_id = student.customer_id
     AND customer.external_company_id = '80d5e42f-2de1-4792-86b5-54c7cdeb2660'
     AND customer.status = 'active'
    -- Migrations use the owner connection, without a Runtime tenant setting.
    -- Reproduce roster eligibility directly instead of the context-bound view.
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links roster
      ON roster.customer_id = student.customer_id AND roster.student_id = student.student_id
     AND roster.student_reference = audited.student_reference
    JOIN public.users account
      ON account.id = roster.user_id AND account.company_id = roster.company_id
     AND account.student_id = audited.student_reference
     AND account.type::text = 'student' AND account.status::text <> 'archived'
    LEFT JOIN LATERAL (
      SELECT c.case_id, c.advisor_name
        FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c
       WHERE c.customer_id = student.customer_id AND c.student_id = student.student_id
       ORDER BY c.created_at DESC, c.case_id DESC LIMIT 1
    ) current_case ON true
    LEFT JOIN LATERAL (
      SELECT nullif(btrim(i.advisor_name), '') AS advisor_name
        FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links link
        JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
          ON i.customer_id = link.customer_id AND i.xero_connection_id = link.xero_connection_id
         AND i.xero_invoice_id = link.xero_invoice_id
       WHERE link.customer_id = student.customer_id AND link.case_id = current_case.case_id
         AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
         AND (i.advisor_name IS NOT NULL OR i.invoice_reference IS NOT NULL OR i.college_name IS NOT NULL)
       ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC LIMIT 1
    ) case_invoice ON current_case.case_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT nullif(btrim(i.advisor_name), '') AS advisor_name
        FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
       WHERE i.customer_id = student.customer_id AND i.student_id = audited.student_reference
         AND current_case.case_id IS NULL
         AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
         AND (i.advisor_name IS NOT NULL OR i.invoice_reference IS NOT NULL OR i.college_name IS NOT NULL)
       ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC LIMIT 1
    ) student_invoice ON current_case.case_id IS NULL
), changed AS (
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students student
     SET advisor_id = directory.advisor_id, updated_at = now(),
         record_version = student.record_version + 1
    FROM current_source source
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory directory
      ON directory.customer_id = source.customer_id
     AND directory.advisor_id = source.target_advisor_id
     AND directory.code = source.target_code AND directory.status = 'active'
   WHERE student.customer_id = source.customer_id AND student.student_id = source.student_id
     AND student.advisor_id IS NOT DISTINCT FROM source.old_advisor_id
     AND student.advisor_id IS DISTINCT FROM directory.advisor_id
     AND source.advisor_xero_name = source.expected_xero_label
  RETURNING student.customer_id, student.student_id, student.record_version
)
INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
  (customer_id, student_id, actor_identity_user_id, event_type, record_version,
   changed_fields, correlation_id)
SELECT customer_id, student_id, 'migration:077_reconcile_student_advisors',
       'student.updated', record_version, ARRAY['advisor_id'],
       '077_reconcile_student_advisors_to_xero.sql'
  FROM changed;
