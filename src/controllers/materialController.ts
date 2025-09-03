import { Request, Response } from 'express';
import { City, Faculty, Department, Subject, Material, DocumentSection, DocumentChunk, TocAnalysis } from '../models';
import jobQueueService from '../services/jobQueueService';
import documentIngestionService from '../services/documentIngestionService';
import r2Service from '../services/r2Service';
import qdrantService from '../services/qdrantService';
import aiPostProcessingService from '../services/aiPostProcessingService';

// Cities
export const getCities = async (req: Request, res: Response) => {
  try {
    const cities = await City.find().sort({ name: 1 });
    res.json({ success: true, cities });
  } catch (error) {
    console.error('Get cities error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createCity = async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'City name is required' });
    }

    const city = new City({ name: name.trim() });
    await city.save();
    
    res.status(201).json({ success: true, city });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'City name already exists' });
    }
    console.error('Create city error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const updateCity = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'City name is required' });
    }

    const city = await City.findByIdAndUpdate(id, { name: name.trim() }, { new: true });
    if (!city) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }
    
    res.json({ success: true, city });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'City name already exists' });
    }
    console.error('Update city error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteCity = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if city has faculties
    const facultyCount = await Faculty.countDocuments({ cityId: id });
    if (facultyCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete city with faculties. Please delete or move faculties first.' 
      });
    }

    const city = await City.findByIdAndDelete(id);
    if (!city) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }
    
    res.json({ success: true, message: 'City deleted successfully' });
  } catch (error) {
    console.error('Delete city error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Faculties
export const getFaculties = async (req: Request, res: Response) => {
  try {
    const { cityId } = req.query;
    
    const query = cityId ? { cityId } : {};
    const faculties = await Faculty.find(query).populate('cityId', 'name').sort({ name: 1 });
    
    res.json({ success: true, faculties });
  } catch (error) {
    console.error('Get faculties error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createFaculty = async (req: Request, res: Response) => {
  try {
    const { name, cityId } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Faculty name is required' });
    }
    
    if (!cityId) {
      return res.status(400).json({ success: false, message: 'City ID is required' });
    }

    const faculty = new Faculty({ name: name.trim(), cityId });
    await faculty.save();
    await faculty.populate('cityId', 'name');
    
    res.status(201).json({ success: true, faculty });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Faculty name already exists in this city' });
    }
    console.error('Create faculty error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getFacultyById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const faculty = await Faculty.findById(id).populate('cityId', 'name');
    if (!faculty) {
      return res.status(404).json({ success: false, message: 'Faculty not found' });
    }
    
    res.json({ success: true, faculty });
  } catch (error) {
    console.error('Get faculty error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteFaculty = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Deleting faculty with ID: ${id}`);
    
    // Find all materials for this faculty
    const materials = await Material.find({ facultyId: id });
    console.log(`📚 Found ${materials.length} materials to delete for faculty`);
    
    // Delete each material and its associated data
    for (const material of materials) {
      console.log(`🗑️ Deleting material: ${material.title} (${material._id})`);
      
      // Delete from R2 if it's a PDF material with R2 key
      if (material.type === 'pdf' && material.r2Key) {
        try {
          await r2Service.delete(material.r2Key);
          console.log(`✅ Deleted from R2: ${material.r2Key}`);
        } catch (r2Error) {
          console.error('⚠️ Failed to delete from R2:', r2Error);
        }
      }
      
      // Delete associated document sections, chunks, and TOC analysis
      try {
        await DocumentSection.deleteMany({ docId: material._id });
        await DocumentChunk.deleteMany({ docId: material._id });
        await TocAnalysis.deleteMany({ docId: material._id });
        await qdrantService.deleteDocument(String(material._id));
        console.log(`✅ Deleted associated data for material: ${material._id}`);
      } catch (dbError) {
        console.error('⚠️ Failed to delete associated data:', dbError);
      }
    }
    
    // Delete all materials for this faculty
    const materialDeleteResult = await Material.deleteMany({ facultyId: id });
    console.log(`🗑️ Deleted ${materialDeleteResult.deletedCount} materials for faculty`);
    
    // Delete all subjects for this faculty
    const subjectDeleteResult = await Subject.deleteMany({ facultyId: id });
    console.log(`🗑️ Deleted ${subjectDeleteResult.deletedCount} subjects for faculty`);
    
    // Delete all departments for this faculty
    const departmentDeleteResult = await Department.deleteMany({ facultyId: id });
    console.log(`🗑️ Deleted ${departmentDeleteResult.deletedCount} departments for faculty`);

    // Delete the faculty itself
    const faculty = await Faculty.findByIdAndDelete(id);
    if (!faculty) {
      return res.status(404).json({ success: false, message: 'Faculty not found' });
    }
    
    console.log(`✅ Successfully deleted faculty: ${faculty.name} and all associated data`);
    res.json({ success: true, message: 'Faculty and all associated data deleted successfully' });
  } catch (error) {
    console.error('Delete faculty error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Departments
export const getDepartments = async (req: Request, res: Response) => {
  try {
    const { facultyId } = req.query;
    
    if (!facultyId) {
      return res.status(400).json({ success: false, message: 'Faculty ID is required' });
    }
    
    const departments = await Department.find({ facultyId }).sort({ order: 1, name: 1 });
    
    res.json({ success: true, departments });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createDepartment = async (req: Request, res: Response) => {
  try {
    const { name, facultyId, availableYears = [1, 2, 3, 4] } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Department name is required' });
    }
    
    if (!facultyId) {
      return res.status(400).json({ success: false, message: 'Faculty ID is required' });
    }

    const department = new Department({ 
      name: name.trim(), 
      facultyId,
      availableYears: availableYears.sort((a: number, b: number) => a - b)
    });
    await department.save();
    
    res.status(201).json({ success: true, department });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Department name already exists in this faculty' });
    }
    console.error('Create department error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const updateDepartment = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, availableYears } = req.body;
    
    const updateData: any = {};
    if (name && name.trim()) {
      updateData.name = name.trim();
    }
    if (availableYears) {
      updateData.availableYears = availableYears.sort((a: number, b: number) => a - b);
    }

    const department = await Department.findByIdAndUpdate(id, updateData, { new: true });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }
    
    res.json({ success: true, department });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Department name already exists in this faculty' });
    }
    console.error('Update department error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteDepartment = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if department has subjects
    const subjectCount = await Subject.countDocuments({ departmentId: id });
    if (subjectCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete department with subjects. Please delete subjects first.' 
      });
    }

    const department = await Department.findByIdAndDelete(id);
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }
    
    res.json({ success: true, message: 'Department deleted successfully' });
  } catch (error) {
    console.error('Delete department error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Subjects
export const getSubjects = async (req: Request, res: Response) => {
  try {
    const { facultyId, departmentId, year } = req.query;
    
    const query: any = {};
    if (facultyId) query.facultyId = facultyId;
    if (departmentId) query.departmentId = departmentId;
    if (year) query.year = parseInt(year as string);
    
    const subjects = await Subject.find(query)
      .populate('departmentId', 'name')
      .sort({ order: 1, name: 1 });
    
    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Get subjects error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createSubject = async (req: Request, res: Response) => {
  try {
    const { name, facultyId, departmentId, year } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Subject name is required' });
    }
    
    if (!facultyId || !departmentId || !year) {
      return res.status(400).json({ success: false, message: 'Faculty ID, Department ID, and Year are required' });
    }

    const subject = new Subject({ 
      name: name.trim(), 
      facultyId,
      departmentId,
      year: parseInt(year)
    });
    await subject.save();
    await subject.populate('departmentId', 'name');
    
    res.status(201).json({ success: true, subject });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Subject name already exists for this department and year' });
    }
    console.error('Create subject error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteSubject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Deleting subject with ID: ${id}`);
    
    // Find all materials for this subject
    const materials = await Material.find({ subjectId: id });
    console.log(`📚 Found ${materials.length} materials to delete for subject`);
    
    // Delete each material and its associated data
    for (const material of materials) {
      console.log(`🗑️ Deleting material: ${material.title} (${material._id})`);
      
      // Delete from R2 if it's a PDF material with R2 key
      if (material.type === 'pdf' && material.r2Key) {
        try {
          await r2Service.delete(material.r2Key);
          console.log(`✅ Deleted from R2: ${material.r2Key}`);
        } catch (r2Error) {
          console.error('⚠️ Failed to delete from R2:', r2Error);
        }
      }
      
      // Delete associated document sections, chunks, and TOC analysis
      try {
        await DocumentSection.deleteMany({ docId: material._id });
        await DocumentChunk.deleteMany({ docId: material._id });
        await TocAnalysis.deleteMany({ docId: material._id });
        await qdrantService.deleteDocument(String(material._id));
        console.log(`✅ Deleted associated data for material: ${material._id}`);
      } catch (dbError) {
        console.error('⚠️ Failed to delete associated data:', dbError);
      }
    }
    
    // Delete all materials for this subject
    const materialDeleteResult = await Material.deleteMany({ subjectId: id });
    console.log(`🗑️ Deleted ${materialDeleteResult.deletedCount} materials`);

    // Delete the subject itself
    const subject = await Subject.findByIdAndDelete(id);
    if (!subject) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    console.log(`✅ Successfully deleted subject: ${subject.name} and all associated data`);
    res.json({ success: true, message: 'Subject and all associated materials deleted successfully' });
  } catch (error) {
    console.error('Delete subject error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Materials
export const getMaterials = async (req: Request, res: Response) => {
  try {
    const { subjectId, facultyId, departmentId, year } = req.query;
    
    const query: any = {};
    if (subjectId) query.subjectId = subjectId;
    if (facultyId) query.facultyId = facultyId;
    if (departmentId) query.departmentId = departmentId;
    if (year) query.year = parseInt(year as string);
    
    const materials = await Material.find(query)
      .populate('subjectId', 'name')
      .sort({ order: 1, createdAt: -1 });
    
    res.json({ success: true, materials });
  } catch (error) {
    console.error('Get materials error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createMaterial = async (req: Request, res: Response) => {
  try {
    const { 
      title, 
      type, 
      r2Key, 
      bucket, 
      url, 
      note, 
      subjectId, 
      facultyId, 
      departmentId, 
      year 
    } = req.body;
    
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Material title is required' });
    }
    
    if (!type) {
      return res.status(400).json({ success: false, message: 'Material type is required' });
    }
    
    if (!subjectId || !facultyId || !departmentId || !year) {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject ID, Faculty ID, Department ID, and Year are required' 
      });
    }

    // For PDF type, r2Key and bucket are required
    if (type === 'pdf' && (!r2Key || !bucket)) {
      return res.status(400).json({ 
        success: false, 
        message: 'R2 key and bucket are required for PDF materials' 
      });
    }

    const material = new Material({ 
      title: title.trim(), 
      type,
      r2Key,
      bucket,
      url,
      note: note?.trim(),
      subjectId,
      facultyId,
      departmentId,
      year: parseInt(year)
    });
    
    await material.save();
    await material.populate('subjectId', 'name');
    
    // PDF material created, but processing will be triggered manually from frontend
    if (type === 'pdf' && r2Key) {
      console.log(`📄 PDF material created: ${material._id} - awaiting page selection for processing`);
    } else {
      console.log(`ℹ️ Non-PDF material created (type: ${type}, r2Key: ${r2Key ? 'present' : 'missing'})`);
    }
    
    res.status(201).json({ success: true, material });
  } catch (error: any) {
    console.error('Create material error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const updateMaterial = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, note } = req.body;
    
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Material title is required' });
    }

    const material = await Material.findByIdAndUpdate(
      id, 
      { 
        title: title.trim(),
        note: note?.trim()
      }, 
      { new: true }
    );
    
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    await material.populate('subjectId', 'name');
    
    res.json({ success: true, material });
  } catch (error) {
    console.error('Update material error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteMaterial = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const material = await Material.findById(id);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    console.log(`🗑️ Deleting material: ${material.title} (${material._id})`);
    
    // Delete from R2 if it's a PDF material with R2 key
    if (material.type === 'pdf' && material.r2Key) {
      try {
        console.log(`🗑️ Deleting material from R2: ${material.r2Key}`);
        await r2Service.delete(material.r2Key);
        console.log(`✅ Successfully deleted from R2: ${material.r2Key}`);
      } catch (r2Error) {
        console.error('⚠️ Failed to delete from R2, but continuing with database deletion:', r2Error);
        // Continue with database deletion even if R2 deletion fails
      }
    }
    
    // Delete associated document sections and chunks
    try {
      const sectionsResult = await DocumentSection.deleteMany({ docId: id });
      console.log(`🗑️ Deleted ${sectionsResult.deletedCount} document sections`);
      
      const chunksResult = await DocumentChunk.deleteMany({ docId: id });
      console.log(`🗑️ Deleted ${chunksResult.deletedCount} document chunks`);
    } catch (dbError) {
      console.error('⚠️ Failed to delete associated document data:', dbError);
    }
    
    // Delete from Qdrant vector database
    try {
      // Delete all vectors for this document
      await qdrantService.deleteDocument(id);
      console.log(`🗑️ Deleted vectors from Qdrant for document: ${id}`);
    } catch (qdrantError) {
      console.error('⚠️ Failed to delete from Qdrant, continuing:', qdrantError);
    }
    
    // Delete from database
    await Material.findByIdAndDelete(id);
    console.log(`✅ Successfully deleted material: ${material.title}`);
    
    res.json({ success: true, message: 'Material deleted successfully' });
  } catch (error) {
    console.error('Delete material error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const analyzeMaterial = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    console.log(`🧠 Starting AI analysis for material: ${id}`);
    
    // Check if material exists
    const material = await Material.findById(id);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    // Check if material has been processed (has sections)
    const sectionCount = await DocumentSection.countDocuments({ docId: id });
    if (sectionCount === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Material must be processed first before analysis. Please process the PDF first.' 
      });
    }
    
    // Run AI analysis
    const result = await aiPostProcessingService.analyzeMaterial(id);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: `AI analysis completed successfully. Processed ${result.processedSections} sections, skipped ${result.skippedSections}.`,
        data: {
          totalSections: result.totalSections,
          processedSections: result.processedSections,
          skippedSections: result.skippedSections
        }
      });
    } else if (result.aborted) {
      res.status(409).json({ 
        success: false, 
        message: `AI analysis was aborted by user. Processed ${result.processedSections} out of ${result.totalSections} sections before abort.`,
        aborted: true,
        data: {
          totalSections: result.totalSections,
          processedSections: result.processedSections,
          skippedSections: result.skippedSections
        }
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: `AI analysis failed: ${result.error || 'Unknown error'}`,
        data: {
          totalSections: result.totalSections,
          processedSections: result.processedSections,
          skippedSections: result.skippedSections
        }
      });
    }
    
  } catch (error) {
    console.error('Analyze material error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getAnalysisStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const status = await aiPostProcessingService.getAnalysisStatus(id);
    
    res.json({ 
      success: true, 
      status: {
        totalSections: status.totalSections,
        analyzedSections: status.analyzedSections,
        pendingSections: status.pendingSections,
        isComplete: status.isComplete,
        percentage: status.totalSections > 0 
          ? Math.round((status.analyzedSections / status.totalSections) * 100)
          : 0
      }
    });
    
  } catch (error) {
    console.error('Get analysis status error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getMaterialSections = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if material exists
    const material = await Material.findById(id);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    // Get all document sections for this material
    const sections = await DocumentSection.find({ docId: id })
      .sort({ pageNumber: 1, createdAt: 1 })
      .select('-vectorId -embedding'); // Exclude vector data for performance
    
    res.json({ 
      success: true, 
      sections,
      count: sections.length
    });
    
  } catch (error) {
    console.error('Get material sections error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getMaterialAnalysis = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if material exists
    const material = await Material.findById(id);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    // For now, we'll create a mock analysis response based on the document sections
    // In the future, this could be stored in a separate MaterialAnalysis collection
    const sections = await DocumentSection.find({ docId: id });
    
    if (sections.length === 0) {
      return res.json({ 
        success: true, 
        analysis: null,
        message: 'No analysis available - material needs to be processed first'
      });
    }
    
    // Create a mock analysis based on available data
    const mockAnalysis = {
      _id: `analysis_${id}`,
      materialId: id,
      summary: `Ovaj materijal sadrži ${sections.length} sekcija sa različitim temama i konceptima relevantnim za predmet.`,
      keyTopics: Array.from(new Set(sections.slice(0, 5).map(section => 
        section.title.split(' ').slice(0, 2).join(' ')
      ))).filter(topic => topic.length > 3),
      difficulty: sections.length > 20 ? 'hard' : sections.length > 10 ? 'medium' : 'easy',
      estimatedReadingTime: Math.round(sections.length * 2.5), // rough estimate
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    res.json({ 
      success: true, 
      analysis: mockAnalysis
    });
    
  } catch (error) {
    console.error('Get material analysis error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Get TOC Analysis for material
export const getMaterialTocAnalysis = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ success: false, message: 'Material ID is required' });
    }

    // Find TOC analysis for this material
    const tocAnalysis = await TocAnalysis.findOne({ docId: id });
    
    if (!tocAnalysis) {
      return res.json({ 
        success: true, 
        tocAnalysis: null,
        message: 'No TOC analysis available - material needs to be processed first'
      });
    }
    
    res.json({ 
      success: true, 
      tocAnalysis 
    });
    
  } catch (error) {
    console.error('Get material TOC analysis error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Update material fields
export const updateMaterialField = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { field, value } = req.body;
    
    if (!id || !field) {
      return res.status(400).json({ success: false, message: 'Material ID and field are required' });
    }

    // Validate allowed fields
    const allowedFields = ['title', 'note'];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ success: false, message: 'Invalid field' });
    }

    const updateData = { [field]: value };
    const material = await Material.findByIdAndUpdate(id, updateData, { new: true });
    
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    res.json({ success: true, material });
    
  } catch (error) {
    console.error('Update material field error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Update document section
export const updateDocumentSection = async (req: Request, res: Response) => {
  try {
    const { sectionId } = req.params;
    const { field, value } = req.body;
    
    if (!sectionId || !field) {
      return res.status(400).json({ success: false, message: 'Section ID and field are required' });
    }

    // Validate allowed fields
    const allowedFields = ['title', 'content', 'shortAbstract', 'keywords', 'queries'];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ success: false, message: 'Invalid field' });
    }

    const updateData = { [field]: value };
    const section = await DocumentSection.findByIdAndUpdate(sectionId, updateData, { new: true });
    
    if (!section) {
      return res.status(404).json({ success: false, message: 'Document section not found' });
    }
    
    res.json({ success: true, section });
    
  } catch (error) {
    console.error('Update document section error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Delete all sections for a material
export const deleteMaterialSections = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ success: false, message: 'Material ID is required' });
    }

    // Delete all sections for this material
    const sectionsResult = await DocumentSection.deleteMany({ docId: id });
    console.log(`🗑️ Deleted ${sectionsResult.deletedCount} document sections for material ${id}`);
    
    // Delete all chunks for this material  
    const chunksResult = await DocumentChunk.deleteMany({ docId: id });
    console.log(`🗑️ Deleted ${chunksResult.deletedCount} document chunks for material ${id}`);
    
    // Reset TOC analysis status to allow re-processing
    await TocAnalysis.findOneAndUpdate(
      { docId: id },
      { 
        $set: { 
          processedSections: 0,
          status: 'pending',
          'sections.$[].processed': false 
        },
        $unset: { error: 1 }
      },
      { new: true }
    );
    console.log(`🔄 Reset TOC analysis status for material ${id}`);
    
    // Set material status to toc_ready so continue processing can work
    await Material.findByIdAndUpdate(id, { status: 'toc_ready' });
    console.log(`📝 Set material status to 'toc_ready' to enable continue processing`);
    
    // Also clean up from vector database if available
    try {
      await qdrantService.deleteDocument(id);
      console.log(`🗑️ Cleaned up vector data for material ${id}`);
    } catch (vectorError) {
      console.warn('⚠️ Failed to clean vector data:', vectorError);
    }
    
    res.json({ 
      success: true, 
      message: `Deleted ${sectionsResult.deletedCount} sections and ${chunksResult.deletedCount} chunks`,
      deletedSections: sectionsResult.deletedCount,
      deletedChunks: chunksResult.deletedCount
    });
    
  } catch (error) {
    console.error('Delete material sections error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Reset TOC processing status - mark all sections as unprocessed
export const resetTocProcessingStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ success: false, message: 'Material ID is required' });
    }

    // Find TOC analysis for this material
    const tocAnalysis = await TocAnalysis.findOne({ docId: id });
    
    if (!tocAnalysis) {
      return res.status(404).json({ success: false, message: 'TOC analysis not found for this material' });
    }

    // Reset all sections to unprocessed state
    const updateResult = await TocAnalysis.findOneAndUpdate(
      { docId: id },
      { 
        $set: { 
          processedSections: 0,
          status: 'pending',
          'sections.$[].processed': false 
        },
        $unset: { error: 1 }
      },
      { new: true }
    );

    if (!updateResult) {
      return res.status(404).json({ success: false, message: 'Failed to update TOC analysis' });
    }

    // Also set material status to toc_ready so continue processing can work
    await Material.findByIdAndUpdate(id, { status: 'toc_ready' });
    
    console.log(`🔄 Reset TOC processing status for material ${id}: ${updateResult.totalSections} sections marked as unprocessed`);
    console.log(`📝 Set material status to 'toc_ready' to enable continue processing`);
    
    res.json({ 
      success: true, 
      message: `Reset TOC processing status - ${updateResult.totalSections} sections marked as unprocessed`,
      totalSections: updateResult.totalSections,
      processedSections: 0
    });
    
  } catch (error) {
    console.error('Reset TOC processing status error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Continue processing material after TOC review
export const continueProcessingMaterial = async (req: Request, res: Response) => {
  try {
    const { id: materialId } = req.params;
    
    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    if (material.status !== 'toc_ready') {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot continue processing. Expected status: toc_ready, current status: ${material.status}` 
      });
    }

    // Start continuation processing in background
    console.log(`🚀 Continuing processing after TOC review for material: ${materialId}`);
    
    setImmediate(async () => {
      try {
        await documentIngestionService.continueProcessingAfterTOC(materialId);
        console.log(`✅ Document processing completed for material: ${materialId}`);
      } catch (processingError) {
        console.error(`❌ Continue processing failed for material ${materialId}:`, processingError);
      }
    });

    res.json({
      success: true,
      message: 'Processing continuation started - using reviewed TOC data',
      materialId,
    });
  } catch (error) {
    console.error('Error continuing processing after TOC:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};